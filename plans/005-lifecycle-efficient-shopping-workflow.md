# Plan 005: Teach, measure and dogfood the lifecycle-efficient shopping workflow

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c0a4e7c..HEAD -- src/core/instructions.ts src/core/mrtr.ts src/core/tools/session.ts src/core/tools/batch.ts src/core/tools/handoff.ts scripts/verify-mcpb-stage.mjs scripts/evaluate-shopping-trace.mjs evals/shopping/amazon-home-office-baseline.json evals/shopping/amazon-home-office-candidate.json tests/unit/shopping-trace.test.ts tests/integration/tools.test.ts tests/integration/mrtr.test.ts NOTES.md plans/README.md`
> Plans 002 and 003 must be DONE. Before execution, replace `c0a4e7c` in this
> drift command and the Status section with their merged HEAD, then refresh every
> excerpt/line reference. Start from a clean worktree and compare current tool
> copy with the refreshed excerpts before editing.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-bound-browser-recovery-loops.md`, `plans/003-safe-short-browser-batches.md`
- **Category**: dx
- **Planned at**: commit `c0a4e7c`, 2026-08-13

## Why this matters

Server mechanics alone cannot remove Claude Desktop's host-owned tool cap. The audited
Amazon run used 48 Steel calls plus two searches in its first long response, retried
several blocked controls, spent most of its only stateful session on an unfinished
comparison, and never invoked handoff before stopping. The next turn arrived after both
idle and hard deadlines.

After Plans 002 and 003, the MCP can offer bounded blocked-control recovery and safe
short batches. This plan makes the intended orchestration explicit within the
strict server/tool byte budgets, adds one deterministic composed shopping contract,
adds a privacy-safe trace evaluator, and treats a newly installed Claude Desktop run as
the final release gate. It does not claim the model will never hit a host cap or that a
quiet session survives arbitrary delay; it ensures that when the model acts efficiently,
one stateful session can reach handoff and explicit release before immutable expiry.

## Current state

- `src/core/instructions.ts:12` currently says scrape first and size `timeout_ms` for an
  expected human step. It does not say to preserve one session from the first necessary
  stateful interaction through cart/handoff or size the timeout for the whole active
  interaction.

- `src/core/instructions.ts:16` already positively recommends batch for known reversible
  steps. Plan 003 makes that advertised path safe; this plan sharpens its short,
  read-independent trigger rather than introducing batching for the first time.

- `src/core/instructions.ts:18` correctly defines explicit handoff and hand-back. It
  does not explain that merely watching the inline viewer does not reserve a quiet
  session across a chat pause.

- The current instructions measure 2,009 bytes against a hard 2,048-byte budget; copy
  must be replaced/compressed, never appended. Browse tools measure 16,769 bytes against
  17,000 (`npm run budget` on 2026-08-13).

- `src/core/tools/session.ts:83-89` calls `timeout_ms` an immutable hard lifetime but
  gives no whole-task heuristic. Create output already reports expiry and takeover.

- `src/core/tools/session.ts:58-64,248-252` correctly says saved profiles are load-only
  and session-only page state disappears on release. Do not duplicate or weaken this.

- The current working tree's `tests/integration/mrtr.test.ts` contains a same-session
  cart/handoff/release test. Plan 003 adds safe batch behavior; this plan composes the
  primitives without replay rather than claiming a hand-scripted test proves model
  orchestration.

- Packaging guidance requires fully quitting/reopening Claude and starting a new
  conversation after installing an MCPB (`README.md:96-100`). Cached conversations may
  keep the old catalog/instructions.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Workflow integration | `npm run test:integration -- tests/integration/tools.test.ts tests/integration/mrtr.test.ts` | both files pass |
| Byte budgets | `npm run budget` | instructions <=2,048; browse <=17,000; 15 tools |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Unit/integration regression | `npm test` | all pass |
| Build/pack | `npm run build && npm run pack:mcpb` | candidate MCPB is produced successfully |
| Trace evaluator | `node scripts/evaluate-shopping-trace.mjs evals/shopping/amazon-home-office-baseline.json --expect baseline && node scripts/evaluate-shopping-trace.mjs evals/shopping/amazon-home-office-candidate.json --expect pass` | baseline is recognized as the known failure and candidate satisfies every objective gate |

## Scope

**In scope**:

- `src/core/instructions.ts`
- `src/core/mrtr.ts`
- `src/core/tools/session.ts`
- `src/core/tools/batch.ts` (copy only; Plan 003 owns behavior)
- `src/core/tools/handoff.ts` (deadline copy only if required)
- `scripts/verify-mcpb-stage.mjs`
- `scripts/evaluate-shopping-trace.mjs` (new)
- `evals/shopping/amazon-home-office-baseline.json` (new, sanitized observed baseline)
- `evals/shopping/amazon-home-office-candidate.json` (new, sanitized dogfood record)
- `tests/unit/shopping-trace.test.ts` (new)
- `tests/integration/tools.test.ts`
- `tests/integration/mrtr.test.ts`
- `NOTES.md` (one link to the sanitized candidate trace and short conclusion only)
- `plans/README.md` (status only)

**Out of scope**:

- Changing any byte-budget ceiling.
- Adding a tool solely to list profiles by friendly name; the tool contract accepts a
  UUID and runtime aliases/identifiers must stay out of fixtures.
- Recording the supplied profile UUID, session/player/CDP URL, Amazon content or cart
  identifiers in source, tests, notes or commits.
- Calling Claude-in-Chrome when the prompt says to use Steel.
- Claiming a stable/public 50-call Anthropic limit.
- Automating payment, order placement, final confirmation, or secrets.
- Reading Claude Desktop IndexedDB from tests or CI.

## Git workflow

- Branch: `fix/lifecycle-efficient-shopping`
- Use TDD for copy/structured-output assertions and composed workflow behavior.
- Suggested commit: `fix(agent): preserve shopping sessions across handoff`
- Do not push or open a PR unless explicitly asked.

## Steps

### Step 1: Write the compact orchestration contract as failing assertions

In `tests/integration/tools.test.ts`, replace broad prose assertions with behaviorally
specific regexes that require all of the following while retaining the security rules:

1. Use stateless reads while they supply the required evidence.
2. At the first necessary stateful interaction—profile, location, JavaScript-only
   verification or cart work—create one sufficiently timed interactive session and
   preserve it through the remaining stateful comparison, cart and handoff. Do not
   churn sessions merely to retry a control.
3. Choose `timeout_ms` for the whole remaining active task and expected handoff. If a
   genuinely separate disposable comparison session is unavoidable, keep it cart-free
   and release it before the final cart session.
4. Use `browser_batch` for the next few known reversible steps only when later targets do
   not need a fresh read.
5. On a batch boundary, hand off on the same session and resume with only unrun steps.
6. A visible viewer is not a reservation; use explicit handoff when the person asked to
   take over.
7. Never promise activity past immutable `expires_at`, and release promptly.

Add schema/result assertions that `timeout_ms` says "whole active task" and create text
says page/cart state does not transfer to a replacement. Preserve existing profile
load-only assertions.

Do not encode the exact wording in one giant string. Assert the semantic clauses so copy
can be compacted later.

**Verify**:
`npm run test:integration -- tests/integration/tools.test.ts`
→ only the new workflow-copy expectations fail before production copy changes.

### Step 2: Replace, do not append, server and tool copy

Rewrite `SERVER_INSTRUCTIONS` compactly. Preserve all existing untrusted-content,
sensitive-data, local-file, handback, diagnostics/replay and human-control exclusions.
Use the post-Plan-003 batch description rather than duplicating its entire contract.

Recommended semantic shape (wordsmith to fit the budget):

```text
Use scrape while it supplies the evidence. At the first necessary stateful interaction,
create one session sized for the remaining active task and handoff; preserve it through
comparison and cart. expires_at cannot extend and replacements do not inherit page/cart.

Batch the next few known reversible steps only when later targets need no read. At a
detected login/challenge boundary, hand off on the same session and resume with only
unrun steps. Stop before payment/final confirmation even when no detector fires.
```

In `src/core/tools/session.ts`, mirror "whole remaining active task" in `timeout_ms`
schema copy and keep its existing actual expiry/remaining/idle notes truthful. In
`src/core/tools/batch.ts`, make only copy refinements needed to align terminology; do not
change behavior here.

**Verify**:

- `npm run test:integration -- tests/integration/tools.test.ts` → pass.
- `npm run budget` → instructions <=2,048 and browse tools <=17,000 without changing
  `tool-budgets.json`.

### Step 3: Make handoff deadlines visible without implying extension

In explicit (`src/core/tools/handoff.ts`) and automatic (`src/core/mrtr.ts`) handoff
user-facing messages, include the absolute browser `expires_at` already known on the
handle, in one short sentence. Say the handoff must finish before that deadline and
cannot extend it. Do not expose `debugUrl` on inline routes, change MRTR routing, or add
a countdown that can become stale.

Extend `tests/integration/mrtr.test.ts` for inline and URL modes:

- both messages include an ISO expiry from the record;
- inline results still contain no player URL;
- handoff grace remains clamped to hard expiry;
- accepted handback reuses the same handle.

**Verify**:
`npm run test:integration -- tests/integration/mrtr.test.ts`
→ all MRTR security and deadline assertions pass.

### Step 4: Add a deterministic composed shopping contract

In `tests/integration/mrtr.test.ts`, add one sanitized primitive-composition regression:

1. Stateless candidate reads create zero sessions while their evidence is sufficient.
2. At the first required stateful preference/location step, one sentinel-profile session
   is created with enough hard runway for the remaining test.
3. That same session performs stateful comparison and a short known batch that configures
   a harmless preference/adds a fake item.
4. A detected clearable login/challenge stops the batch; explicit handoff uses the same
   handle and no completed mutation replays.
5. Handback completes promptly within the advertised idle/hard deadlines; a fresh
   snapshot contains the same fake cart item.
6. Only the precise unrun work executes, and explicit release closes the exact original Steel
   session once.

Assert outcomes and session counts, not a brittle exact sequence of every read. Use
sentinel profile IDs and fixture product names, never the real UUID or retailer output.
This proves the primitives compose without replay; it does not prove a model will choose
the workflow. The Desktop dogfood in Step 7 is the orchestration evaluation.

**Verify**:
`npm run test:integration -- tests/integration/mrtr.test.ts`
→ the composed workflow passes with one cart-holding session and no replay.

### Step 5: Make dogfood evidence sanitized and machine-checkable

Add `scripts/evaluate-shopping-trace.mjs` plus unit coverage and two JSON records under
`evals/shopping/`. Define a versioned schema containing only:

- candidate version/commit and host version;
- segment-relative millisecond timestamps and host `stop_reason`;
- model-visible tool names in order, logical session aliases such as `cart_session`
  (never real handles), and low-cardinality outcome/error codes;
- boolean outcomes for Steel-only use, candidate selection, cart preservation,
  handoff/hand-back, explicit release and no order placed.

Split those booleans into `observed` gates, which the event sequence can prove, and an
`operator_attestations` object for semantic judgments such as candidate-list
completeness or whether a sequence was read-independent. The evaluator validates that
required attestations are present but must label them as attestations, never derived
facts.

Reject unknown/forbidden keys recursively, including arguments, URLs, page text,
profile/session IDs, player/CDP links, cookies, product/account data and credentials.
App-only live-view calls must be omitted, not inferred as model decisions.

Encode the audited baseline from the already-redacted evidence: its first long segment
has 48 model-visible Steel calls plus two searches, its continuation has 50 Steel calls,
both end in `tool_use_limit`, repeated blocker recovery occurs, and neither handoff nor
release happens. The evaluator's `--expect baseline` mode must recognize these known
failures without treating the fixture as a passing candidate.

For `--expect pass`, require:

- Steel is the only browser integration;
- one logical stateful session is preserved from first necessary stateful interaction
  through cart and handoff (a separately declared cart-free disposable session is the
  only allowed extra create/release pair);
- the sanitized event stream contains no more than Plan 002's threshold of consecutive
  `click_blocked` outcomes without an intervening successful operation; this is a
  conservative trace gate and does not infer DOM relationships;
- deterministic fixture `step_id`s prove this plan's composed regression batches known,
  read-independent work; the live dogfood provides a required operator attestation for
  the equivalent semantic judgment rather than pretending tool names prove it;
- explicit handoff, hand-back verification and release occur in that order;
- no action occurs after payment/final-confirmation boundary and no order is placed;
- any continuation starts before both advertised idle and hard relative deadlines.

Do not infer stop reasons or model-visible call counts from raw MCP transport logs. If
Claude Desktop offers no supported export/copy path that distinguishes model-visible
calls and stop reasons, STOP the trace/dogfood gate and report that host limitation;
never read IndexedDB in the evaluator or CI.

**Verify**:

- `npm run test:unit -- tests/unit/shopping-trace.test.ts` → schema, redaction,
  baseline-failure and candidate-pass fixtures behave as specified.
- `node scripts/evaluate-shopping-trace.mjs evals/shopping/amazon-home-office-baseline.json --expect baseline`
  → exit 0 and prints only aggregate failure codes.

### Step 6: Run all automated release gates and package exact bytes

**Verify**:

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm test` → all pass.
- `npm run budget` → all ceilings unchanged and green.
- `npm run build` → exit 0.
- `npm run pack:mcpb` → one candidate matching `package.json` version appears under
  `build/`.
- `git diff --check` → no output.
- `git status --short` → every changed path is listed in this plan's Scope (plus the
  intentional status-only `plans/README.md` update).

### Step 7: Install fresh and run the Claude Desktop dogfood gate

With operator approval and a test/shopping account that cannot accidentally place an
order, use this exact macOS install and verification path:

1. Pack and open the exact candidate:

   ```bash
   npm run pack:mcpb
   open "build/steel-mcp-$(node -p 'require("./package.json").version').mcpb"
   ```

2. After the installer reports success, fully quit Claude Desktop, verify no Claude
   process remains, reopen it, and start a **new conversation**.
3. Discover the current user's extension root at runtime:

   ```bash
   claude_extensions_root="$(node -p 'require("node:path").join(require("node:os").homedir(), "Library/Application Support/Claude/Claude Extensions")')"
   find "$claude_extensions_root" -maxdepth 1 -type d -name 'local.mcpb.*steel*' -print
   ```

   Require exactly one result and assign its absolute path to
   `claude_steel_install`; never commit that path. Unpack the exact candidate artifact
   into a disposable directory and compare the installed runtime against that packed
   payload—not `build/mcpb`, whose staging tree contains declarations deliberately
   omitted by pack:

   ```bash
   candidate_version="$(node -p 'require("./package.json").version')"
   candidate_unpack="$(mktemp -d)"
   npx --yes @anthropic-ai/mcpb@2.1.2 unpack "build/steel-mcp-$candidate_version.mcpb" "$candidate_unpack"
   diff -qr "$candidate_unpack" "$claude_steel_install"
   ```

   Register a trap to remove only this validated `mktemp` directory on exit. Run
   `node scripts/verify-mcpb-stage.mjs "$candidate_unpack"` and the same command against
   `"$claude_steel_install"`.
4. As part of this plan, extend `scripts/verify-mcpb-stage.mjs` so that the probe verifies
   the initialized version, exactly 15 browse tools, `browser_session_handoff`, and the
   absence of `region` from `browser_session_create.inputSchema.properties`. The tree
   packed-payload comparison proves the installed timeout/idle implementation is the
   tested candidate. Print only version, tool count and default durations, never
   configuration secrets or capability identifiers.
5. Send this exact prompt, supplying the saved-profile UUID only when Claude requests it
   and never recording it:

   ```text
   Use only Steel Browser with the saved profile UUID I will provide at runtime. We have
   a new product designer starting Monday. On Amazon.de, put together a sensible home-
   office setup delivered to Berlin 10115 for under EUR 450 and add everything to my
   cart. Prefer Prime delivery, good ratings, and avoid unnecessary premium gear. Stop
   before login, CAPTCHA, payment, or final confirmation; let me take over and do not
   place the order. Keep the winning cart open and briefly summarize the alternatives.
   ```
6. Stop before login, CAPTCHA, payment or final confirmation and never place an order.

Acceptance observations:

- no Claude-in-Chrome calls;
- a complete candidate list and budget estimate exist before the first add-to-cart in
  the final cart-holding session; any earlier JavaScript comparison session is
  disposable, holds no cart, and is explicitly released;
- at least one sequence of two or more known read-independent steps uses a short batch,
  while dynamic targets that require a fresh read are not blindly batched;
- blocked-control recovery stops after the bounded strategy rather than cycling through
  siblings indefinitely;
- takeover invokes `browser_session_handoff`, not merely a viewer link;
- after Hand back, a fresh snapshot reads the same cart session;
- session release is explicit when the test ends;
- if Claude still reaches `tool_use_limit`, record it as host behavior and verify the
  same session survives an immediate continuation only when the create result showed
  enough time remaining under both its actual `inactivity_timeout_ms` and immutable
  `expires_at`. Plan 004 is optional and must not be assumed.

Populate `evals/shopping/amazon-home-office-candidate.json` through the supported
conversation export/copy path using logical aliases and relative times only. Run the
evaluator, then add one short `NOTES.md` entry linking the fixture and its overall
result. Do not copy retailer page content, cart items, arguments, account data,
profile/session IDs, player URLs or credentials.

The first two acceptance bullets (candidate completeness and correct classification of
read-independent steps) are recorded under `operator_attestations`; the evaluator must
print them separately from event-derived PASS results.

**Verify**:

- `node scripts/evaluate-shopping-trace.mjs evals/shopping/amazon-home-office-candidate.json --expect pass`
  → exit 0.
- `NOTES.md` links the candidate fixture and names version/commit plus PASS; any failed
  evaluator gate keeps Plan 005 IN PROGRESS.

## Test plan

- Copy contract: stateless reads while sufficient, one stateful session from first
  necessary interaction through cart/handoff, whole-task timeout, short known batch,
  viewer-not-reservation, immutable expiry, explicit release.
- Handoff contract: absolute expiry on inline/URL paths, no inline player URL, same
  handle after handback.
- Composed primitive flow: stateless reads while sufficient, one preserved stateful session,
  short batch, detected boundary, prompt hand-back, same cart, unrun work only, release.
- Trace evaluation: exact sanitized baseline metrics, forbidden-field rejection,
  episode/batch/session/handoff/release/deadline gates for the candidate.
- Desktop dogfood: fresh installed bundle and conversation; behavioral checklist rather
  than retailer availability assertions.

## Done criteria

- [ ] Agent/server copy encodes the lifecycle-efficient workflow under existing budgets.
- [ ] `timeout_ms` explicitly covers the whole active task and expected handoff.
- [ ] Replacement sessions are not represented as preserving page/cart state.
- [ ] Handoff messages expose immutable expiry without leaking player URLs inline.
- [ ] The composed primitive regression passes with one final cart session and no replay.
- [ ] Sanitized baseline is recognized as failing and the candidate trace passes every
      machine-checkable evaluator gate.
- [ ] Typecheck, lint, tests, budgets, build, pack and diff checks pass.
- [ ] Installed runtime matches a fresh extraction of the exact `.mcpb` artifact, and
      both extracted/installed probes pass the version/tool/schema checks.
- [ ] A freshly installed Claude Desktop candidate passes every objective redacted
      dogfood check.
- [ ] No order was placed and no secret/capability identifier was recorded.
- [ ] No file outside scope changed.
- [ ] `plans/README.md` marks Plan 005 DONE.

## STOP conditions

Stop and report back if:

- Plans 002 or 003 are not DONE and verified, or their merged HEAD was not used to
  refresh this plan's drift/excerpts.
- Required semantic copy cannot fit without raising a budget or deleting security text.
- The composed test needs to promise cross-session cart persistence.
- Handoff deadline copy would expose a drive-capable player/CDP URL on an inline path.
- Claude Desktop is not demonstrably running the newly built bundle/new tool catalog.
- No supported host export/copy path can provide model-visible tool names and stop
  reasons without private cache access.
- Dogfood would require a real purchase, secret in tool arguments, or an account with no
  safe test boundary.
- Any automated verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The observed 50-call cap belongs to one Claude host/version/account and must remain an
  eval observation, never an MCP guarantee.
- Retailer pages are volatile. Judge future dogfood on orchestration, state continuity
  and safety boundaries rather than a particular product's stock.
- Re-run the Desktop gate whenever tool discovery, instructions, batching, lifecycle or
  handoff behavior changes.
