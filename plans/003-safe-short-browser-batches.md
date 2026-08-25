# Plan 003: Stop short browser batches at detected login/challenge boundaries

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c0a4e7c..HEAD -- src/core/mrtr.ts src/core/errors.ts src/core/tools/batch.ts src/core/tools/shared.ts tests/unit/batch.test.ts tests/unit/errors.test.ts tests/integration/mrtr.test.ts tests/integration/tools.test.ts plans/README.md`
> Then run `git status --short` and `git diff --` on exactly those paths. The
> working tree used to write this plan also contained unrelated cart/profile,
> schema and region-removal hunks in the integration/error files. Those hunks
> must already have a separate owner/commit, or be isolated with patch staging
> and excluded from this plan's staged diff. STOP rather than make a mixed commit.
> If another plan lands first, replace `c0a4e7c` with that HEAD and refresh every
> excerpt/line reference before execution.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `c0a4e7c`, 2026-08-13

## Why this matters

Claude Desktop stopped both long Amazon turns after exactly 50 model-issued tools.
`browser_batch` can replace several deterministic calls with one, but the current handler
directly invokes page operations and never runs the login/CAPTCHA classifier used by
the equivalent individual tools. Promoting it as a tool-budget solution today can run
later steps after a detected login/CAPTCHA boundary.

The safe outcome is a short, read-independent batch that stops at its first failure or
a **detected clearable login/CAPTCHA boundary**, reports exactly what completed, and
never replays mutations. It should direct the model to call explicit
`browser_session_handoff` on the same session, then start a new batch containing only the
unrun steps. Payment and final-confirmation avoidance remains a model/tool-contract
rule; this plan does not pretend the structural classifier can recognize every checkout
boundary.

## Current state

- `src/core/tools/batch.ts:10-25` permits `browser_navigate`, `browser_act` and
  `browser_wait_for`; its nested `timeout_ms` is positive but has no maximum.

- `src/core/tools/batch.ts:50-100` loops through up to 20 steps, calls the page methods
  directly, and stops only when one throws:

  ```ts
  for (const [index, step] of args.steps.entries()) {
      // page.navigate / page.act / page.waitFor
      // failures wrap completed_steps and failed_step
  }
  ```

- `src/core/tools/browse.ts:69-93,230-276,300-342` calls
  `resolveHumanHandoff` after individual navigation/action, and after a wait timeout.
  This is the behavior batch currently bypasses.

- `src/core/mrtr.ts:215-256` privately reads structural page evidence and classifies it.
  `resolveHumanHandoff` then performs MRTR, records rounds and pins the session. Calling
  that whole function from the middle of a batch is unsafe: a retried MCP call would
  re-enter at step one and could add the same cart item twice.

- `src/core/instructions.ts:16` and the current batch tool description already
  positively recommend `browser_batch` for known reversible checkout steps. This plan
  makes that advertised path safe; Plan 005 only refines and dogfoods the guidance.

- `tests/integration/mrtr.test.ts:492-548` covers automatic handoff for individual
  navigate, act and wait calls. `tests/integration/tools.test.ts:1441-1500` covers batch
  success, schema validation and first-failure stopping, but no detected block boundary.

- `src/core/tools/shared.ts:81-93` touches the registry once before the whole page
  operation. A long multi-step batch does not touch between steps or inspect the request
  abort signal between steps.

- Existing error convention: return a `SteelToolError` with a stable code and
  low-cardinality structured details; page text remains fenced or omitted.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Targeted integration | `npm run test:integration -- tests/integration/tools.test.ts tests/integration/mrtr.test.ts` | both files pass |
| Targeted unit | `npm run test:unit -- tests/unit/errors.test.ts` | error contract passes; if Step 4 creates `tests/unit/batch.test.ts`, include it in this command |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Unit/integration regression | `npm test` | all pass |
| Tool and instruction budgets | `npm run budget` | 15 browse tools; all byte budgets pass without raising them |

## Scope

**In scope**:

- `src/core/mrtr.ts`
- `src/core/errors.ts`
- `src/core/tools/batch.ts`
- `src/core/tools/shared.ts` (only if a small touch/abort helper prevents duplication)
- `tests/integration/mrtr.test.ts`
- `tests/integration/tools.test.ts`
- `tests/unit/batch.test.ts` (new only if an extracted runner is used for abort progress)
- `tests/unit/errors.test.ts`
- `plans/README.md` (status only)

**Out of scope**:

- Automatically completing an elicitation inside `browser_batch`.
- Persisting batch progress in unsigned client input or replaying completed steps after
  handoff.
- Blindly batching dynamic checkout controls whose refs are not known yet.
- Changing the public maximum of 20 steps; keep compatibility and guide models toward
  shorter sequences.
- Extending session idle/hard lifetimes; Plan 004 owns lifecycle defaults.
- A background keepalive or host-specific Claude counter.

## Git workflow

- Branch: `fix/safe-short-browser-batches`
- Use TDD: boundary tests must fail before handler changes.
- Commit style: Conventional Commits. Suggested message:
  `fix(batch): stop at detected login boundaries`
- Do not push or open a PR unless explicitly asked.

## Steps

### Step 1: Extract non-eliciting structural inspection

Refactor `src/core/mrtr.ts` so page evidence and `assessInteractiveBlock` can be reused
without starting MRTR. Export one narrowly named helper, for example
`inspectInteractiveBlock(page)`, returning only:

- the `BlockVerdict | null`;
- the final URL needed by existing sanitized error builders.

Keep snapshot controls/evidence internal. Do not return raw page text to batch, export
the external player URL, record a handoff round, mint request state, or call
`registry.awaitInput` from this helper. It may preserve the existing final-page URL
solely for the existing interactive-block error path; this plan does not broaden that
surface. Never return a debug/player URL, profile/session identifier or evidence text.
Update `resolveHumanHandoff` to use the same helper so there remains one classifier.

Add/retain tests proving a working shop with a reCAPTCHA footer returns no boundary,
while a real login wall and operable challenge do.

**Verify**:
`npm run test:integration -- tests/integration/mrtr.test.ts`
→ all existing automatic handoff behavior remains green.

### Step 2: Characterize safe batch stopping without replay

In `tests/integration/mrtr.test.ts`, add modern-client cases for:

1. A batch navigation lands on a clearable login wall. That successful navigation
   counts as completed: for step 1 of 2, assert `completed_steps=1`, `next_step=2`, and
   `remaining_steps=1`. The sentinel second action is skipped, no elicitation starts,
   and the typed error names the same public handle conceptually (never the Steel UUID)
   plus `browser_session_handoff`.
2. A successful batch action raises an operable CAPTCHA. Use the same post-success
   accounting. When this is the final step, assert `next_step=null` and
   `remaining_steps=0`; handoff is still required even though no batch step remains.
3. A wait timeout caused by a clearable login wall did **not** complete the wait. For
   step 2, assert `completed_steps=1`, `next_step=2`, and remaining work includes the
   wait plus later steps. An unrelated wait timeout remains an ordinary operation
   failure with `failed_step=2`.
4. A recognized non-clearable bot block stops remaining steps but preserves the existing
   mitigation ladder, sets no `handoff_required`, and does not tell the caller to invoke
   handoff as though a person could clear it. Because it is also detected after a
   successful navigate/act, assert the same exact `completed_steps`, `next_step`,
   `remaining_steps` and “do not rerun completed steps” accounting.
5. Calling explicit `browser_session_handoff` after a clearable-boundary error preserves the same
   handle/page state, and a new batch containing only the unrun sentinel step succeeds.
6. Exactly one Steel session was created throughout. Count the fake page action or
   `Input.dispatchMouseEvent` calls and assert the completed cart mutation remains
   exactly 1; assert the continuation batch contains precisely the unrun step.

Add unit coverage for the new error builder in `tests/unit/errors.test.ts`. Use existing
`loginWallPage`, `captchaPage`, `cartPage` and `FakeSteelApi` patterns; do not add real
retailer data.

**Verify**:
`npm run test:integration -- tests/integration/mrtr.test.ts`
→ only new batch-boundary expectations fail before implementation.

### Step 3: Stop a batch at a detected clearable boundary

In `src/core/tools/batch.ts`, inspect after each successful `browser_navigate` and
`browser_act`. For `browser_wait_for`, inspect only when the wait throws the same typed
timeout the individual handler inspects. Match individual-tool behavior rather than
classifying every successful wait unnecessarily.

Keep operation failures and post-operation boundary results on separate code paths; do
not let the existing catch block wrap a successful step as failed. When a clearable
login/CAPTCHA boundary is found:

- stop before executing the next step;
- do not call `resolveHumanHandoff` and do not return `input_required` from inside batch;
- throw a typed, actionable error built in `src/core/errors.ts`;
- preserve block classification (`login_required` or `bot_detection`) and add structured
  `completed_steps`, `next_step`, `remaining_steps`, and
  `handoff_required: true`;
- say explicitly not to rerun completed steps, to call
  `browser_session_handoff` with the same public session handle, and then to submit only
  the unrun steps in a new batch.

For a recognized but non-clearable block, keep the existing mitigation-ladder error,
skip remaining steps, and omit/false `handoff_required`. Still attach the same
post-success completed/unrun accounting and no-replay guidance; mitigation changes the
next strategy, not whether the completed mutation counts. Never expose the player URL,
profile/session identifiers or raw page evidence in the batch error. Preserve only the
existing final-page URL behavior.

**Verify**:
`npm run test:integration -- tests/integration/tools.test.ts tests/integration/mrtr.test.ts`
→ boundary, continuation and existing first-failure tests all pass.

### Step 4: Bound execution after caller cancellation and keep the handle fresh

Give a batch-nested wait the same explicit `.max(120_000)` validation as standalone
`browser_wait_for`; this closes an inconsistent schema but does not claim the Amazon run
had an MCP call timeout. Between steps:

- check `ctx.mcpReq.signal.aborted` and stop before the next step;
- touch the same public handle after each completed step so the local reaper cannot
  treat an actively progressing batch as abandoned.

Do not swallow cancellation and do not close the pooled CDP connection. This plan does
not require cancelling a CDP command already in flight; each CDP command retains its
existing 30-second bound. Through the real MCP client, assert caller rejection and that
the sentinel second step never runs—the client discards a cancelled tool result. If the
internal completed-step state must be inspected, extract a small runner and unit-test it
in `tests/unit/batch.test.ts` with an already-aborted signal. Do not promise a
model-visible typed timeout unless a protocol-level test proves one is delivered.

**Verify**:
`npm run test:integration -- tests/integration/tools.test.ts`
→ cancellation rejects client-side, the sentinel remains unrun, and batch schema
rejects a wait over 120 seconds. If the runner was extracted, its targeted unit test also
passes.

### Step 5: Tighten the batch tool description without yet changing global instructions

Replace the current batch description with compact wording that states all of:

- use it for the next few known, reversible steps;
- later targets must already be known without a fresh page read;
- at most one end snapshot is returned;
- it stops on the first failure or detected login/challenge boundary;
- use explicit handoff, then resume with only unrun steps;
- stop before payment or final confirmation.

Do not change `SERVER_INSTRUCTIONS` here; Plan 005 updates global guidance after the
safe implementation exists. Update the schema-copy assertion in
`tests/integration/tools.test.ts` and stay inside the existing 17,000-byte browse-tool
budget.

Update `src/core/tools/batch.ts`'s `ABOUTME:` comment to promise at most one snapshot is
**returned**. Boundary inspection may take internal snapshots, so “taking at most one”
would be false. Keep payment/final-confirmation avoidance as explicit model guidance,
not as a claimed classifier capability.

**Verify**:
`npm run budget`
→ 15 browse tools, browse payload <=17,000 bytes, instructions <=2,048 bytes.

### Step 6: Run regression gates

**Verify**:

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm test` → all unit/integration tests pass.
- `npm run budget` → all budgets pass without increasing `tool-budgets.json`.
- `git diff --check` → no output.
- `git diff --cached --name-only` and `git diff --cached` → only this plan's paths and
  hunks are staged; existing profile/region/click work is not mixed in.

## Test plan

- Structural classifier reuse: ordinary page, login wall, operable CAPTCHA,
  non-clearable block.
- Batch: clearable boundary after successful navigate/act; login on failed wait;
  non-clearable mitigation; exact post-success versus failed-step accounting including
  null-next; later steps skipped; explicit handoff then only unrun steps; mutation count
  remains one; caller abort; standalone-parity nested wait maximum.
- Regression: current batch success, invalid action and first failure remain green.

## Done criteria

- [ ] `browser_batch` cannot continue past a detected login/CAPTCHA boundary.
- [ ] A boundary never auto-elicits or replays completed batch mutations.
- [ ] Clearable boundaries identify completed/unrun work and direct explicit same-session
      handoff; non-clearable blocks retain mitigation without false handoff guidance.
- [ ] Aborted calls execute no later batch step.
- [ ] Active multi-step progress refreshes local handle use between steps.
- [ ] The description positively defines a short, read-independent batch.
- [ ] Targeted tests, `npm run typecheck`, `npm run lint`, `npm test`, and
  `npm run budget` pass.
- [ ] No budget ceiling is raised.
- [ ] No file outside scope is changed.
- [ ] `plans/README.md` marks Plan 003 DONE.

## STOP conditions

Stop and report back if:

- Correct MRTR behavior appears to require retrying `browser_batch` from step one.
- Progress would need unsigned client state, page evidence, debug/player URLs or
  selectors in request state/details. Preserving the existing final-page URL alone is
  not a scope expansion.
- The classifier cannot be reused without weakening its clearable-control checks.
- Atomic safety would require a new cross-backend active-operation lease; record that as
  a follow-up rather than shipping an in-memory-only flag.
- Tool copy cannot fit the existing byte budget without removing security guidance.
- A verification fails twice after a reasonable fix attempt.
- Unrelated existing hunks cannot be separated from this plan's staged commit.

## Maintenance notes

- Any new batch step type must declare whether and when detected login/challenge
  inspection runs; payment/final-confirmation safety remains an explicit contract.
- A future resumable batch protocol would need signed progress state and exactly-once
  mutation semantics; this plan intentionally avoids that complexity.
- Keep model guidance toward short batches even though the API maximum remains 20.
