# Plan 006: Attribute browser-session release causes without private cache forensics

> **Executor instructions**: Follow this plan step by step and verify each gate before
> continuing. This is observability, not a retention-policy change. Never add session,
> profile, URL, principal or page data to logs/spans. STOP on any privacy or cross-replica
> ambiguity rather than emitting a misleading cause. Update `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat c0a4e7c..HEAD -- src/core/registry.ts src/core/registry-redis.ts src/core/telemetry.ts src/hosted-runtime.ts src/hosted.ts src/stdio.ts tests/unit/registry.test.ts tests/unit/registry-redis.test.ts tests/unit/registry-conformance.test.ts tests/integration/tracing.test.ts tests/unit/hosted-runtime.test.ts plans/README.md`
> Replace `c0a4e7c` with current HEAD before execution and refresh line references.
> Run `git status --short` and inspect the same paths; STOP if unrelated dirty hunks
> cannot be staged separately.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none; refresh against Plan 004 first if its registry policy has landed
- **Category**: observability
- **Planned at**: commit `c0a4e7c`, 2026-08-13

## Why this matters

The Amazon investigation required decoding private Claude Desktop cache state to prove
that the first browser was lost after both idle and hard deadlines rather than an MCP
timeout. Current registry counters collapse idle and hard expiry into `reaper`, and
stdio shutdown also calls `reap({ idleMs: 0 })`, so ordinary logs cannot distinguish an
abandoned browser, immutable expiry, explicit release, or host/process shutdown.

This plan makes the release cause a low-cardinality, exactly-once outcome in both
registry backends and emits a redacted structured log plus OpenTelemetry signal. It
does not record which browser, user, profile, page or retailer was involved.

## Current state

- `src/core/registry.ts:8` defines `ReleasePath` as `explicit | stream_close | reaper`.
- Both in-memory and Redis `reap` calculate `idle` and `expired` but increment only the
  shared `reaper` count (`src/core/registry.ts:313-331`,
  `src/core/registry-redis.ts:418-461`).
- Explicit and aborted-create paths already use `explicit` and `stream_close`.
- stdio and hosted shutdown release everything by sweeping with `idleMs: 0`, which
  currently looks identical to an idle reaper.
- Tool-call and Steel REST spans deliberately omit arguments/messages/URLs with query
  data (`src/core/telemetry.ts`). No lifecycle signal exists.
- Registry conformance already checks exactly-once counts and Redis release races; this
  is the right layer to pin cause semantics.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Registry units | `npm run test:unit -- tests/unit/registry.test.ts tests/unit/registry-redis.test.ts tests/unit/registry-conformance.test.ts tests/unit/hosted-runtime.test.ts` | both backends and shutdown behavior pass |
| Tracing integration | `npm run test:integration -- tests/integration/tracing.test.ts` | release signal has only allow-listed attributes |
| Regression | `npm run typecheck && npm run lint && npm test && npm run build` | all pass |

## Scope

**In scope**:

- `src/core/registry.ts`
- `src/core/registry-redis.ts`
- `src/core/telemetry.ts`
- `src/hosted-runtime.ts`
- `src/hosted.ts`
- `src/stdio.ts`
- `tests/unit/registry.test.ts`
- `tests/unit/registry-redis.test.ts`
- `tests/unit/registry-conformance.test.ts`
- `tests/unit/hosted-runtime.test.ts`
- `tests/integration/tracing.test.ts`
- `plans/README.md` (status only)

**Out of scope**:

- Changing hard, inactivity, handoff or reaper durations.
- Logging capability handles, Steel session IDs, principals, profile IDs, URLs, page
  content, tool arguments, credentials or error messages.
- Inferring Claude `tool_use_limit`; that remains a host stop reason.
- Promising the local cause is Steel's server-side teardown reason. It describes the
  MCP registry decision that successfully finalized the record.
- Building a dashboard or changing public MCP tool output.

## Git workflow

- Branch: `feat/session-release-causes`
- Use TDD in registry conformance before changing either backend.
- Suggested commit: `feat(observability): attribute session release causes`
- Do not push or open a PR unless explicitly asked.

## Steps

### Step 1: Define exact cause and precedence semantics

Replace the collapsed release path with these stable causes:

- `explicit`: `browser_session_release` completed successfully;
- `stream_close`: create-request cancellation or a process-owned runtime/transport
  shutdown released it;
- `idle`: the registry idle threshold elapsed while hard expiry had not;
- `hard_expiry`: `expiresAt <= now`, even when idle is also true.

Hard expiry wins when both predicates are true. A failed Steel release emits/counts
nothing and retains the record for retry. An idempotent second release emits/counts
nothing. In Redis, only the replica whose atomic forget removes the record emits the
cause.

Add a dedicated `releaseAll('stream_close')` (or equivalently explicit shutdown mode)
only for a process-owned in-memory registry, rather than abusing `reap({ idleMs: 0 })`.
Keep ordinary `reap` responsible only for `idle` and `hard_expiry`.

For a shared Redis registry, an individual hosted replica does not own the deployment-
wide live set and must not release it on shutdown: another replica may be actively
serving those handles. On shared-backend replica close, stop accepting requests and
close only that replica's local CDP pools/clients; shared records remain available for
explicit release or normal idle/hard reaping. Characterize this as an intentional
limitation—do not invent creator ownership, because a different replica can be the
current user.

**Verify**: registry-conformance tests fail first for all four causes, precedence,
failed-release silence, idempotency and concurrent-Redis exactly-once behavior.

### Step 2: Implement backend-parity attribution

Update the registry interface, in-memory backend and Redis backend together. Keep the
release/fencing order unchanged: call Steel, atomically forget the record, then count
and notify. Introduce a `RegistryDeps.onReleased(cause)` callback only after successful
finalization. Its payload is the cause enum and no record fields. Notification is
best-effort: catch callback failures after finalization so logging/telemetry can never
turn an irreversible successful release into a reported failure. Add a separate
low-cardinality internal warning if needed, without record data.

Expose a non-secret registry capability such as
`shutdownScope: 'process_owned' | 'shared'`: in-memory returns `process_owned`, Redis
returns `shared`, and test/custom backends must declare one explicitly. Hosted runtime
uses that capability rather than `instanceof` or environment guessing.

Route stdio and hosted runtimes using process-owned in-memory registries through
`releaseAll('stream_close')`. For hosted shared Redis, remove the current global
`reap({ idleMs: 0 })` shutdown behavior and leave shared records for the remaining
replicas/reaper as described above. Preserve hard-expiry enforcement and all existing
human-control fencing.

**Verify**:
`npm run test:unit -- tests/unit/registry.test.ts tests/unit/registry-redis.test.ts tests/unit/registry-conformance.test.ts tests/unit/hosted-runtime.test.ts`
→ both implementations report the same exactly-once causes.
Also assert a throwing `onReleased` callback does not reject a successful release or
change its count, and a shared-Redis replica close releases no deployment-wide handle.

### Step 3: Emit redacted logs and telemetry

Add a telemetry helper that records one short `steel session released` span/event with
only these allow-listed attributes:

- `steel.session.release_cause` (the four-value enum);
- `steel.deployment` (`cloud` or `self_hosted`);
- `steel.registry.backend` (`memory` or `redis`).

Wire the same callback to the existing structured stderr logger with message
`browser session released` and fields `{ cause, deployment, registry_backend }` only.
Do not include duration unless it is bucketed and separately justified; cause alone
answers this incident.

In tracing tests, assert the exact attribute-key set and recursively reject keys/values
matching `id|handle|principal|profile|url|page|credential|token|cookie|argument`.

**Verify**:
`npm run test:integration -- tests/integration/tracing.test.ts`
→ one successful release emits one allow-listed signal; failures and duplicate releases
emit none.

### Step 4: Run regression and privacy gates

**Verify**:

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm test` → all unit/integration tests pass.
- `npm run build` → exit 0.
- `rg -n "sessionId|steelSessionId|profileId|debugUrl|viewerUrl|principal"` over the new
  logging/telemetry assertions shows those values are never emitted.
- `git diff --check` → no output.
- `git diff --cached` contains only this plan's hunks.

## Test plan

- In-memory and Redis: explicit, stream close, idle, hard expiry, both-predicate
  precedence, release failure/retry, duplicate release, concurrent reapers.
- Runtime: process-owned shutdown uses `stream_close`; shared-Redis replica shutdown
  releases no shared handle; callback failure is non-fatal.
- Telemetry/logging: exact allow-list, exactly once, no record data or error prose.

## Done criteria

- [ ] `reaper` is no longer an externally recorded release cause.
- [ ] Idle and hard expiry are distinguishable with hard-expiry precedence.
- [ ] Shutdown is distinguishable from ordinary idle cleanup.
- [ ] Both registry backends emit exactly one cause only after successful finalization.
- [ ] Logs and telemetry contain only the three allow-listed low-cardinality fields.
- [ ] All targeted and full verification commands pass.
- [ ] `plans/README.md` marks Plan 006 DONE.

## STOP conditions

Stop and report if:

- Redis cannot atomically ensure only the winning forget emits a cause.
- Emitting a useful signal would require any record identifier, principal or URL.
- Existing exporters automatically attach disallowed request attributes to the release
  signal and they cannot be suppressed.
- Runtime shutdown cannot be separated from ordinary reaping without weakening cleanup.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- New release paths must extend the enum, both backend conformance cases, and the
  telemetry allow-list in the same change.
- This signal explains MCP registry behavior. Steel server-side lifecycle telemetry is
  a separate source and must not be conflated with it.
