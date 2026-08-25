# Plan 001: Make Codex handoff single-surface and unambiguous

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer dispatched you and said they maintain the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 5b2cb76..HEAD -- src/core/tools/handoff.ts src/core/mrtr.ts src/core/instructions.ts tests/unit/mrtr.test.ts tests/integration/apps.test.ts tests/integration/mrtr.test.ts tests/integration/tools.test.ts README.md NOTES.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> material mismatch, treat it as a STOP condition.

## Status

- **Execution status**: Core implementation complete; deployed Codex smoke test pending
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5b2cb76`, 2026-08-10

## Why this matters

Codex currently renders the Steel session viewer from both
`browser_session_create` and `browser_session_handoff`, while the server's
per-request UI-extension check evaluates false and therefore chooses URL
elicitation. It is not yet established whether Codex declares the UI extension
only at initialize time or omits it entirely; that distinction must be measured
before changing capability resolution. A person can drive the inline viewer
successfully, but its Hand back button only releases the browser-control lease;
it does not accept the separate URL elicitation, so Codex keeps showing Action
required and can finish the tool as declined or cancelled.

The safe server-side outcome is one inline viewer per created session plus one
explicit MRTR completion gate. Do not remove Action required: that is the
protocol mechanism that keeps the agent paused. Remove the redundant viewer,
make inline and URL completion instructions truthful, and resolve initialize-
versus-request capabilities according to the wire era actually observed. The
per-request envelope remains authoritative whenever present, so no client is
given a capability it did not declare for that request.

## Current state

- `src/core/tools/session.ts:91-93` is the canonical viewer attachment. It puts
  `_meta.ui.resourceUri` on `browser_session_create`, so supporting hosts render a
  live viewer when the browser session is created:

  ```ts
  // A host that supports MCP Apps renders the live viewer beside this result.
  _meta: { ui: { resourceUri: SESSION_VIEWER_URI } },
  ```

- `src/core/tools/handoff.ts:54-66` attaches the same resource to the explicit
  handoff tool, causing a second app instance in hosts that render tool UI:

  ```ts
  host.registerTool(
      'browser_session_handoff',
      {
          // ...
          _meta: { ui: { resourceUri: SESSION_VIEWER_URI } },
      },
  ```

- `src/core/tools/handoff.ts:107-133` builds one message for both paths. If the
  request lacks the UI extension but declares URL elicitation, the server
  correctly returns `inputRequired.elicitUrl(...)`, even if the host happens to
  render `_meta.ui` without advertising that capability:

  ```ts
  const message =
      `A person needs to ${REASON_TEXT[args.reason]}${origin ? ` on ${origin}` : ''}. ` +
      'Take control of the live browser, choose Hand back when finished, then continue; the agent will re-read the page.';

  if (supportsInlineViewer(serverCtx) && supportsElicitation(serverCtx)) {
      // form elicitation for the already-rendered inline viewer
  }

  if (supportsUrlElicitation(/* ... */)) {
      // URL elicitation for Steel's external player
  }
  ```

- `src/core/mrtr.ts:158-165` lets URL elicitation fall back to capabilities an
  older connection declared at initialize, with the per-request envelope taking
  precedence whenever it exists:

  ```ts
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? declaredAtConnect?.();
  return declared?.elicitation?.url !== undefined;
  ```

- `src/core/mrtr.ts:190-193` currently has no equivalent initialize fallback
  for the UI extension. Do not guess from client identity; first measure whether
  Codex actually declares the extension at initialize:

  ```ts
  export function supportsInlineViewer(ctx: ServerContext): boolean {
      const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined;
      return envelope?.[CLIENT_CAPABILITIES_META_KEY]?.extensions?.[UI_EXTENSION_NAME] !== undefined;
  }
  ```

- `src/core/apps/session-viewer.ts:1293-1305` shows why Hand back cannot finish
  MRTR by itself. It only calls `browser_session_live_view` with `action: 'release'`:

  ```js
  function releaseControl(){
    // ...
    return controlCall('release', token).catch(function(){});
  }
  ```

- The measured Codex run on 2026-08-10 rendered both tool-associated viewer
  surfaces, emitted a URL-mode Action required card, and ended
  `browser_session_handoff` after roughly 34 seconds with
  `The person declined or cancelled browser control.` Do not copy the live
  player URL or session UUID from the run log into tests, docs, commits, or
  issues; the player URL is a drive-capable bearer capability.

- Test conventions:
  - `tests/integration/apps.test.ts` inspects `_meta.ui` on listed tools through
    `uiMetaOf(...)` and is the right place to pin which tools instantiate the
    viewer.
  - `tests/integration/mrtr.test.ts` uses a real MCP client on both modern and
    legacy wire eras and is the right place to pin routing and elicitation copy.
  - `tests/unit/mrtr.test.ts` already pins the capability-helper behavior,
    including URL's initialize-era fallback and UI's current lack of one.
  - `tests/integration/tools.test.ts` pins the user-facing server instructions
    and their 2 KB budget.
  - Error paths assert both the returned error and clean captured output. Match
    that pattern for any new error-path case.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Targeted unit baseline | `npm run test:unit -- tests/unit/mrtr.test.ts` | 1 file and 27 tests pass at the planned commit |
| Targeted integration baseline | `npm run test:integration -- tests/integration/apps.test.ts tests/integration/mrtr.test.ts` | 2 files and 59 tests pass at the planned commit |
| Typecheck | `npm run typecheck` | exit 0, no TypeScript errors |
| Lint | `npm run lint` | exit 0, no Biome errors |
| Unit and integration suites | `npm test` | all unit and integration tests pass |
| Tool/instruction budgets | `npm run budget` | browse remains at 15 tools and all byte budgets pass |

Do not run `npm install` unless dependencies are missing. This plan adds no
dependency. `npm run test:browser` is not required unless the executor touches
`src/core/apps/session-viewer.ts`, which is out of scope; if that file becomes
necessary, stop and report first.

## Scope

**In scope** (the only product/test/docs files to modify):

- `src/core/tools/handoff.ts`
- `src/core/mrtr.ts`
- `src/core/instructions.ts`
- `tests/unit/mrtr.test.ts`
- `tests/integration/apps.test.ts`
- `tests/integration/mrtr.test.ts`
- `tests/integration/tools.test.ts`
- `README.md`
- `NOTES.md`
- `plans/README.md` (status update only)

**Out of scope** (do not touch):

- `src/core/apps/session-viewer.ts` — the control lease works; this plan does not
  invent an unsupported app-to-elicitation completion channel.
- `src/core/tools/session.ts` — keep `browser_session_create` as the single
  canonical app attachment.
- `src/core/registry.ts` and `src/core/registry-redis.ts` — no new handoff state
  or polling protocol is needed.
- Client-name checks such as `if (clientInfo.name === 'Codex')`.
- Any change that puts `debugUrl`, a `/player` URL, a CDP URL, token, or API key
  into ordinary text or structured model content. The player URL stays only in
  URL elicitation.
- Changes to MCP SDK dependencies or protocol versions.
- Changes to Codex itself. Record the host capability mismatch as an upstream
  follow-up; do not work around it by violating capability negotiation.

## Git workflow

- Branch: `fix/codex-handoff-ux`
- Use TDD: commit the failing characterization tests before or together with the
  implementation if the repository's normal review practice permits it.
- Commit message style is Conventional Commits, matching recent history. Use
  `fix(handoff): avoid duplicate Codex viewer` for the final logical commit.
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Measure the capability source Codex actually sends

Before changing routing, run one disposable diagnostic build against Codex. In
`src/core/tools/handoff.ts`, temporarily emit one structured JSON line to stderr
immediately before the first capability branch. Record booleans only:

- whether `ctx.mcpReq.envelope` contains `CLIENT_CAPABILITIES_META_KEY`;
- request-envelope `extensions[UI_EXTENSION_NAME]` present;
- request-envelope `elicitation` present, plus its `form` and `url` members;
- initialize-declared `extensions[UI_EXTENSION_NAME]` present from
  `host.server.getClientCapabilities()`;
- initialize-declared `elicitation` present, plus its `form` and `url` members.

Use a fixed event name such as `steel.handoff.capability_probe`. Do **not** log
the full capability objects, request state, arguments, handle, URL, principal,
headers, or any token. Run one harmless explicit review handoff in Codex,
capture the single line, then remove the diagnostic before writing production
tests or committing anything.

Classify the result:

- **Route A — initialize fallback is warranted:** the request envelope is
  absent, while initialize capabilities declare both the UI extension and
  elicitation (a bare 2025-era `elicitation` object counts as form support).
  Implement the conditional fallback in Step 4.
- **Route B — host mismatch:** neither capability source declares the UI
  extension, or the only declared interaction is URL elicitation. Keep the
  capability helpers strict and implement only deduplication/copy. Record a
  redacted upstream Codex issue recommendation in `NOTES.md`.
- **Unexpected:** a per-request envelope declares UI + elicitation but the
  server still emitted URL mode. Stop: the observed branch contradicts the
  current code and must be diagnosed before this plan continues.

**Verify**:

- Exactly one structured probe line exists and contains booleans only.
- `rg -n "steel\.handoff\.capability_probe" src tests`
  → no matches after the probe is removed.
- `git diff -- src/core/tools/handoff.ts`
  → no probe-only change remains.

### Step 2: Characterize the single-viewer contract

In `tests/integration/apps.test.ts`, add a test beside the existing
`browser_session_create` metadata test that lists tools and asserts:

1. `browser_session_create` still has
   `_meta.ui.resourceUri === SESSION_VIEWER_URI`.
2. `browser_session_handoff` has no `_meta.ui.resourceUri` and therefore cannot
   instantiate a second copy of the session viewer.
3. `browser_session_live_view` remains app-only with
   `_meta.ui.visibility === ['app']`.

Name the test by behavior, e.g. `attaches the viewer once, when the session is
created, rather than again for handoff`. Do not assert the entire tool object;
pin only the three metadata facts so unrelated descriptions can evolve.

**Verify**:
`npm run test:integration -- tests/integration/apps.test.ts`
→ the new test fails only because `browser_session_handoff` still carries the
resource URI; all pre-existing tests pass.

### Step 3: Characterize the measured Codex route and conforming inline route

In `tests/integration/mrtr.test.ts`, add a capability fixture that exactly
matches the non-secret fields captured in Step 1. Name it for its purpose (for
example `codexObservedCapabilities`), and add a comment with the observation
date. Do not call `{ elicitation: { url: {} } }` the observed Codex shape unless
the probe actually produced that shape.

Keep the existing `inlineCapabilities` with both form/URL elicitation and
`[UI_EXTENSION_NAME]` as the conforming modern-host shape.

Add or tighten explicit-handoff tests so they assert:

1. Under Route B, the observed Codex capabilities produce exactly one URL-mode
   elicitation containing the sanitized `/player` URL. Under Route A, add this
   assertion for a separate URL-only client fixture and make the observed
   legacy Codex fixture expect form mode after the fallback is implemented.
2. Every URL-mode result tells the person to complete the step in the **linked/opened
   browser** and then return to the MCP client and accept/confirm the pending
   request. It must not claim that clicking Hand back alone completes the
   request and must not refer to a viewer "above."
3. Conforming inline capabilities produce form mode with no URL anywhere in
   the serialized result. Its copy points to the existing live viewer and tells
   the person to Hand back **and** confirm the pending request.
4. An accepted retry returns the existing `handoff.status: 'returned'` result;
   a declined/cancelled retry retains the existing typed error. Do not weaken
   this state validation.

Also update the automatic login/CAPTCHA handoff assertions in the same file so
their inline and URL messages follow the same two-stage truth. Prefer a small
message-building helper in production over duplicating fragile sentences in
two modules, but do not export host-specific words such as "Codex" or "Action
required."

**Verify**:
`npm run test:integration -- tests/integration/mrtr.test.ts`
→ only the new copy/metadata expectations fail before production changes;
all security assertions (origin-only prose, URL credential stripping, no
`/player` on inline results, signed state) remain green.

For Route A, add TDD coverage before production changes:

- In `tests/unit/mrtr.test.ts`, require `supportsInlineViewer` and
  `supportsElicitation` to accept an optional initialize-capability callback,
  matching `supportsUrlElicitation`.
- Assert the per-request envelope is authoritative: if it is present and omits
  the UI extension, an initialize declaration must not override it.
- Assert a request with no envelope can use initialize-declared UI +
  elicitation, and no declaration remains false.
- In `tests/integration/mrtr.test.ts`, replace the existing legacy test that
  unconditionally expects an external URL despite an initialize-declared UI
  extension. The replacement must expect inline/form only when initialize
  capabilities also declare elicitation under the legacy rules.

**Verify for Route A**:
`npm run test:unit -- tests/unit/mrtr.test.ts`
→ only the new fallback expectations fail before production changes; all
request-state, URL sanitization, and origin sanitization tests remain green.

### Step 4: Remove the redundant handoff app and split completion copy by mode

In `src/core/tools/handoff.ts`:

1. Remove the `SESSION_VIEWER_URI` import.
2. Remove `_meta.ui.resourceUri` from `browser_session_handoff`. Do not move it to
   another tool; `browser_session_create` is already the canonical attachment.
3. Replace the one shared `message` with mode-appropriate messages:
   - Inline/form mode: say to use the existing live browser viewer, choose Hand
     back when done, then confirm the pending request in the client.
   - URL mode: say to use the browser opened by the link, finish the step, then
     return to the client and confirm the pending request. Do not mention the
     inline Hand back button.
   - Inline-without-elicitation fallback: retain its explicit warning that the
     tool cannot formally pause; tell the model to wait for direct user
     confirmation. Do not represent this fallback as equivalent to MRTR.
4. Preserve the exact routing order: conforming inline + elicitation first,
   URL elicitation second, inline-without-elicitation fallback third, then the
   capability error.
5. Preserve `requestState`, origin sanitization, `awaitInput`, expiry clamping,
   principal authorization, and the accepted/declined retry behavior.

In `src/core/mrtr.ts`, update the automatic login/CAPTCHA inline and URL copy to
use the same completion semantics. If a small pure helper is introduced for
completion copy, keep page-derived strings out of it and test it through the
integration results rather than exporting a new public API solely for tests.

For **Route A only**, extend `supportsInlineViewer` and `supportsElicitation`
with the same optional `declaredAtConnect` callback pattern already used by
`supportsUrlElicitation`:

```ts
const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? declaredAtConnect?.();
```

The nullish-coalescing order is load-bearing: a present per-request envelope is
authoritative and must not be augmented from initialize state. Pass
`host.server.getClientCapabilities()` from explicit handoff, and use the
existing `request.declaredAtConnect` callback in automatic handoff. Do not
change URL capability resolution.

For **Route B**, leave all three capability helpers unchanged. The host did not
declare an inline route, so URL elicitation remains the only protocol-authorized
pause.

**Verify**:

- `rg -n "SESSION_VIEWER_URI|resourceUri" src/core/tools/handoff.ts`
  → no matches.
- `npm run test:unit -- tests/unit/mrtr.test.ts`
  → all tests pass. Under Route A, fallback and request-authority tests pass;
  under Route B, capability behavior remains unchanged.
- `npm run test:integration -- tests/integration/apps.test.ts tests/integration/mrtr.test.ts`
  → all tests, including the new single-viewer and copy cases, pass.

### Step 5: Align model and user guidance with the real two-stage handoff

Update `src/core/instructions.ts` within the existing 2 KB cap. The instruction
must tell the model:

- Hand back releases exclusive browser control.
- A pending client handoff prompt must also be confirmed before the tool
  completes.
- The model must not resume browser actions merely because it assumes the
  person clicked Hand back; wait for the completed tool result, then take a
  fresh snapshot.

Update `tests/integration/tools.test.ts` to pin those semantics without matching
one exact paragraph. Keep its existing human-control and 2 KB assertions.

Update `README.md` under "Watching, and taking over" to distinguish:

- the one viewer instantiated by session creation;
- Hand back returning the control lease;
- the client's pending handoff confirmation allowing MRTR to retry;
- URL elicitation as the fallback when the request does not declare the UI
  extension.

Update `NOTES.md` with a short measured Codex compatibility entry dated
2026-08-10. Record only non-secret facts: Codex rendered tool UI while its
server-visible capability envelope selected URL elicitation, two tool UI
attachments produced two viewers, Hand back did not accept the outer
elicitation, and the final handoff result was declined/cancelled. Redact all
session IDs and player URLs.

**Verify**:

- `npm run test:integration -- tests/integration/tools.test.ts`
  → server-instruction tests pass.
- `npm run budget`
  → the instruction remains ≤ 2048 bytes and the browse profile remains
  within its existing byte budget. Do not raise `tool-budgets.json`.
- `rg -n "49593d04|api\.steel\.dev/v1/sessions/.+/player" README.md NOTES.md plans`
  → no live session identifier or concrete player capability appears.

### Step 6: Run automated regression gates

Run the repository checks covering this transport-independent protocol change:

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. `npm run budget`
5. `npm run conformance`

Do not update snapshots or budgets merely to make failures disappear. Investigate
any mismatch against the intended single-viewer contract.

**Verify**: every command exits 0. `git diff --name-only` lists only the in-scope
files and `plans/README.md`.

### Step 7: Perform a real Codex smoke test

Build/start the server through the same configuration used by Codex, then run a
fresh task with a harmless page:

1. Ask Codex to create one Steel session and navigate to `https://example.com`.
2. Ask to see the live session, then invoke `browser_session_handoff` for review.
3. Confirm exactly one Steel Browser viewer exists for the session. The handoff
   tool must not add a second viewer.
4. Confirm Codex still shows Action required. This is the safe pause, not a
   failure.
   - Route A: it is form mode with no player URL. Use the existing inline
     viewer, choose Hand back, then accept/confirm the pending request.
   - Route B: it contains the sanitized external-player URL. Complete the
     linked browser step, then return to Codex and accept/confirm the pending
     request.
5. Confirm `browser_session_handoff` returns success (not
   declined/cancelled), Codex takes a fresh snapshot, and only then resumes.
6. Release the session.

Capture only capability names, UI counts, result status, and timestamps. Never
paste the session UUID, player URL, CDP URL, or tokens into the repository.

**Verify**: one viewer, one pending completion gate, successful handoff result,
fresh snapshot after completion, and released session.

If the smoke's capability route differs from the Step 1 probe, stop and inspect
whether Codex changed versions or the diagnostic observed a different wire era.

## Test plan

- `tests/integration/apps.test.ts`
  - one canonical viewer attachment on `browser_session_create`;
  - no viewer resource URI on `browser_session_handoff`;
  - app-only visibility unchanged on `browser_session_live_view`.
- `tests/integration/mrtr.test.ts`
  - a fixture matching the measured Codex capability source selects the
    expected Route A or Route B behavior;
  - URL copy requires client confirmation and does not tell the person that
    inline Hand back completes it;
  - conforming inline envelope selects form mode, leaks no player URL, and
    requires both Hand back and client confirmation;
  - accepted and declined retries keep their current semantics;
  - automatic login/CAPTCHA handoff uses the same truthful completion copy.
- `tests/unit/mrtr.test.ts` (Route A only)
  - initialize-declared UI and elicitation are used only when no per-request
    envelope exists;
  - a present per-request envelope remains authoritative;
  - missing declarations remain false.
- `tests/integration/tools.test.ts`
  - model instructions distinguish browser lease return from MRTR completion;
  - instructions remain under 2 KB.
- Real Codex smoke
  - exactly one viewer plus one explicit completion gate;
  - completed handoff succeeds and is followed by a fresh page read.

Use existing test helpers and real MCP client harnesses. Do not add a fake Codex
client or production mock mode; the relevant server-visible capability shape is
already expressible through `HarnessOptions.capabilities`.

## Done criteria

- [ ] `browser_session_create` is the only model-visible tool with
      `_meta.ui.resourceUri === SESSION_VIEWER_URI`.
- [ ] `browser_session_handoff` no longer imports or references
      `SESSION_VIEWER_URI`.
- [ ] URL-mode handoff explicitly requires finishing in the linked browser and
      confirming the pending request in the MCP client.
- [ ] Inline-mode handoff explicitly requires Hand back and client confirmation.
- [ ] Capability behavior matches the measured route: Route A adds only the
      initialize fallback with per-request authority; Route B leaves all three
      helpers unchanged.
- [ ] Inline results contain no `/player`, `debugUrl`, CDP URL, or credential.
- [ ] URL player capabilities remain confined to URL elicitation.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run budget`, and
      `npm run conformance` all exit 0.
- [ ] The real Codex smoke shows one viewer, one completion gate, a successful
      handoff result, and a fresh snapshot after completion.
- [ ] No files outside Scope are modified, apart from the status row in
      `plans/README.md`.
- [ ] `plans/README.md` marks Plan 001 DONE only after the Codex smoke passes.

## STOP conditions

Stop and report back; do not improvise if:

- Any in-scope current-state excerpt has materially drifted from commit
  `5b2cb76`.
- Removing `_meta.ui` from `browser_session_handoff` also prevents Codex from
  rendering the viewer attached to `browser_session_create`.
- The Step 1 diagnostic exposes a capability combination not covered by Route A
  or Route B, or the final smoke differs from the probe.
- A proposed fix requires client-name sniffing, assuming rendered UI without a
  declared capability, or returning form elicitation to a client that did not
  declare it.
- A proposed fix removes `input_required`, resumes the agent before an explicit
  completion signal, or trusts Hand back as proof that the person finished the
  requested page work.
- A proposed fix needs the viewer app to accept another request's elicitation,
  but the host exposes no documented bridge operation for doing so.
- Any player/CDP URL or credential would leave its current security boundary.
- A verification command fails twice after one reasonable correction.
- The fix requires modifying an out-of-scope product file.

## Maintenance notes

- Under Route B, report the Codex mismatch upstream with redacted evidence: a
  host that renders MCP Apps should advertise `io.modelcontextprotocol/ui` in
  the appropriate capability view. If it supports empty form elicitation as
  well, this server can use its credential-safer inline branch. Under Route A,
  record that the server now honors the initialize-era declaration only when
  no per-request envelope exists.
- Do not "fix" the mismatch by recognizing Codex's client name. Capability
  envelopes are per-request and are the security/compatibility contract.
- The Action required card remains intentional. It is the human confirmation
  gate, not a second browser. The user-visible bug is the redundant viewer and
  misleading implication that Hand back alone completes MRTR.
- A future seamless Hand back → MRTR acceptance design needs an explicit,
  standardized app-to-host completion signal. Until one exists, keep lease
  release and handoff acceptance separate and accurately described.
- Reviewers should scrutinize that player URLs remain only inside URL
  elicitation and that the inline path still serializes without `/player`.
