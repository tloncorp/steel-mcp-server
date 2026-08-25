# Plan 002: Bound blocked-control recovery episodes on real Chrome

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c0a4e7c..HEAD -- src/core/page.ts src/core/errors.ts tests/unit/page.test.ts tests/unit/errors.test.ts tests/e2e/fixture-site/server.mjs tests/e2e/browse.e2e.test.ts plans/README.md`
> Then run `git status --short` and `git diff --` on the same paths. This plan
> was written while an uncommitted first pass at click hardening was present.
> Preserve and reconcile that work. `errors.ts` and `errors.test.ts` also held
> unrelated region-removal hunks: those must already have a separate owner or
> commit, or be isolated with patch staging and excluded from this plan's staged
> diff. If behavior differs materially from the excerpts below, STOP rather than
> overwrite or make a mixed commit.
> If Plan 003 or another prerequisite cleanup lands first, replace `c0a4e7c` with
> that HEAD and refresh all excerpts/line references before execution.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `c0a4e7c`, 2026-08-13; reviewed with an uncommitted click-hardening diff

## Why this matters

The audited Amazon run exhausted Claude Desktop's observed 50-tool turn budget while
moving among alternate links, wrappers and add-to-cart controls on the same document.
The current working-tree fix escalates a second failure only when the exact same
`(loaderId, backendNodeId)` fails twice. A model can therefore keep receiving
first-retry advice by changing to a sibling or wrapper node. The new multi-point hit
test also exists only under mocked CDP tests even though repository policy requires
real-browser coverage for browser behavior.

After this plan, one reproducible sibling/wrapper recovery episode is bounded, resets
only after verified interaction/DOM progress or cross-document navigation, and is
proven against real Chrome. The implementation must continue refusing unverified
clicks; reducing tool calls must never mean clicking a covered payment or checkout
control speculatively.

## Current state

- `src/core/page.ts:131-138` samples the centre and four inset points inside the real
  transformed content quad:

  ```ts
  const CLICK_SAMPLE_POSITIONS = [
      [0.5, 0.5],
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
  ];
  ```

- `src/core/page.ts:207-208,470-475` tracks only one exact live node:

  ```ts
  private lastClickFailure: { nodeKey: string; failures: number } | undefined;

  const nodeKey = `${handle.loaderId}:${handle.backendNodeId}`;
  const failures = this.lastClickFailure?.nodeKey === nodeKey
      ? this.lastClickFailure.failures + 1
      : 1;
  ```

- `src/core/page.ts:478-505` refreshes geometry once, probes safe points, clears the
  exact-node failure as soon as a reachable point is found, and otherwise emits one of
  the bounded click errors. Clearing before dispatch/settle is premature.

- `src/core/errors.ts:474-508` tells the caller to reacquire and retry once, then change
  strategy or call `browser_session_handoff`. The repeated flag is exact-node state; the
  error builder has no document-level context.

- `tests/unit/page.test.ts` covers transformed quads, an inset success, a full cover,
  same-node repeat escalation, document reset, and `DOM.getNodeForLocation` recovery.
  These are mocked CDP tests.

- `tests/e2e/browse.e2e.test.ts:56-85` proves that real Chrome rejects a fully covered
  click and succeeds after dismissing the overlay. It does not prove that a centre-only
  cover uses a clear inset point or that failures across different nodes are bounded.

- `tests/e2e/fixture-site/server.mjs:29-54` is the existing adversarial overlay fixture.
  New browser fixtures belong here; production must not gain a mock mode.

- Repository conventions: source files begin with two `ABOUTME:` lines, error paths
  assert both the typed error and absence of unsafe input, and browser behavior requires
  `npm run test:e2e` (`CLAUDE.md`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Dirty-baseline unit tests | `npm run test:unit -- tests/unit/page.test.ts tests/unit/errors.test.ts` | both files pass |
| Real-browser E2E | `npm run test:e2e` | E2E project passes; no browser-behavior skip on a configured stack |
| Typecheck | `npm run typecheck` | exit 0, no TypeScript errors |
| Lint | `npm run lint` | exit 0, no Biome errors |
| Unit and integration regression | `npm test` | all unit and integration tests pass |
| Diff hygiene | `git diff --check` | no output, exit 0 |

Do not run `npm install` unless dependencies are missing. This plan adds no dependency.

## Scope

**In scope** (the only product/test/docs files to modify):

- `src/core/page.ts`
- `src/core/errors.ts`
- `tests/unit/page.test.ts`
- `tests/unit/errors.test.ts`
- `tests/e2e/fixture-site/server.mjs`
- `tests/e2e/browse.e2e.test.ts`
- `plans/README.md` (status update only)

**Out of scope** (do not touch):

- Session timeout, idle-reaper or handoff-grace defaults; Plan 004 owns those.
- `src/core/tools/batch.ts`; Plan 003 owns batching.
- Auto-clicking, coordinate guessing, JavaScript evaluation, or weakening the hit test.
- A host-specific Claude tool counter. The MCP server cannot observe that contract.
- Remote-object cleanup in multi-point hit testing. Track that separately as P2
  performance debt; it was not causal in this run.
- Screenshots, selectors, page text, URLs, profile IDs or session IDs from the audited
  Amazon run in tests or documentation.

## Git workflow

- Branch: `fix/bounded-browser-recovery`
- Preserve the user's existing dirty changes. Do not reset, checkout, or overwrite them.
- Use TDD: write the alternate-node and real-Chrome cases before production changes.
- Commit style is Conventional Commits. Suggested message:
  `fix(browser): bound recovery across blocked controls`
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Characterize the real failure shape across alternate targets

First add a deterministic fixture that reproduces the audited shape without retailer
data: one obstructed control must be reacquired as its button, label/wrapper and child,
so three distinct backend node IDs all fail inside one recovery episode. Each failure
must expose the same hit-tested covering backend node ID, or the candidate targets must
have a machine-verifiable DOM ancestor/descendant relationship. Prove the fixture fails
today before designing broader state. Also add three independent blocked controls with
different blockers and no DOM relationship; they must **not** be treated as one episode,
even if no successful action occurs between them.

Define an episode narrowly as consecutive safe-click failures on one loader that also
share a machine-verifiable blocker ID or target DOM relationship, with no successful
operation-owned reset or cross-document loader change between them. Same-loader timing
alone is never enough. The reset allowlist is: a click/check whose pointer dispatch and
settle both succeed; successful type/fill/select; a recognized overlay dismiss control
that was actually clicked and settled; or a cross-document loader change. Generic
`domMutated` is never sufficient because retailer animations can mutate continuously.
A fresh find/snapshot, pure scroll, hover, ambient mutation, or failed/no-change overlay
dismissal does not prove progress.

In `tests/unit/page.test.ts`, characterize:

1. The first two distinct but related sibling/wrapper failures receive bounded recovery
   guidance.
2. The third failure in that same deterministic episode gets stronger guidance to stop
   trying variants, change path or use `browser_session_handoff`.
3. A successful dispatched-and-settled click/check and successful type/fill/select reset
   the episode, but merely finding a reachable point does not: inject mouse-dispatch and
   settle failures to prove both.
4. Failed `Page.navigate` and same-document navigation preserve the episode.
5. A successful cross-document navigation and explicit cross-document `go_back` reset
   it, even when the new document reuses backend IDs.
6. Unrelated blocked controls with different blockers/DOM ancestry stay independent.
   A recognized overlay control actually clicked and settled resets related state;
   snapshot/find/scroll/hover, ambient DOM mutations, and a no-change/failed overlay
   dismissal do not.

Use a named threshold constant rather than a magic number. Recommended threshold: three
failures inside the reproduced episode. Keep immediate escalation for a second failure
on the exact same node.

In `tests/unit/errors.test.ts`, characterize the episode-exhausted error separately from
the exact-node repeated error. It must say no further click variant should be tried and
offer another path or `browser_session_handoff`; it must not imply login, CAPTCHA, payment
or final confirmation was detected.

**STOP gate**: if the sibling/wrapper fixture cannot reproduce the loop deterministically,
or distinguishing it from independent controls requires page semantics/guessed
selectors, keep only the existing exact-node escalation and real-Chrome hit-test tests;
do not ship cross-node episode state.

**Verify**:
`npm run test:unit -- tests/unit/page.test.ts tests/unit/errors.test.ts`
→ only the reproduced episode/reset expectations fail before production changes.

### Step 2: Implement episode-scoped bounded recovery

Only after Step 1's fixture passes the STOP gate, retain the exact-node key and add
episode state keyed by loader ID **and** stable blocker backend ID or verified target
relationship, plus a progress epoch. Centralize transitions:

- record a safe-click failure for both the exact node and current episode;
- report exact-node repetition and episode-threshold exhaustion independently;
- clear only for the operation-owned reset allowlist above or a successful
  main-document loader change; never for generic `domMutated` alone;
- preserve state when hit testing merely finds a point, dispatch/settle throws,
  navigation fails, or navigation keeps the same loader;
- observe loader changes from snapshot, navigate and cross-document `go_back` paths.

Do not conflate three unrelated controls: the negative fixture from Step 1 must reset on
its intervening verified progress. If the chosen progress signal cannot keep that case
green, stop rather than broadening the heuristic.

Extend the error builders in `src/core/errors.ts` with an episode-exhausted mode or a
separate builder. Preserve existing typed `click_blocked` details, and add only
low-cardinality fields such as `reason: 'click_recovery_exhausted'`; never add selectors
or page prose beyond the blocker description already returned.

**Verify**:
`npm run test:unit -- tests/unit/page.test.ts tests/unit/errors.test.ts`
→ all old and new tests pass, and no failing case dispatches mouse input.

### Step 3: Prove the algorithm against real Chrome

Add a route such as `/centre-covered-button` to
`tests/e2e/fixture-site/server.mjs`. It must render a genuine button whose centre is
covered by a separate high-z-index element while at least one inset point remains clear.
Clicking the button must mutate a visible outcome string.

In `tests/e2e/browse.e2e.test.ts`:

1. Find the button by accessibility text, click it, and assert the DOM outcome changed.
   This proves real Chrome selected a clear inset rather than failing at the centre.
2. Use the deterministic sibling/wrapper obstruction from Step 1 and assert the third
   failure in one episode emits stronger stop guidance with no mutation.
3. Exercise failed/same-document navigation and then cross-document `go_back`; only the
   cross-document loader change resets initial guidance.

Do not assert exact sample coordinates; assert user-visible behavior and safety.

**Verify**:
`npm run test:e2e`
→ the real-browser suite passes and reports no configured browser test as skipped.

### Step 4: Run the full regression gate

Run the full checks after reconciling the existing dirty patch. Review the diff for
unrelated changes and make sure the initial region-removal/session work was neither
lost nor folded into this commit accidentally.

**Verify**:

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm test` → all unit/integration tests pass.
- `npm run test:e2e` → pass.
- `git diff --check` → no output.
- `git diff --cached --name-only` and `git diff --cached` → staged hunks contain only
  this plan; region/session work is not mixed into the commit.

## Test plan

- Unit: reproduced sibling/wrapper IDs on one loader; exact-node second failure;
  episode threshold; dispatch/settle success and failure; operation-owned reset;
  ambient mutation non-reset; failed/same-document/cross-document navigation; no unsafe
  mouse dispatch.
- Real browser: centre-only obstruction succeeds through an inset; full obstruction
  remains rejected; sibling/wrapper variants exhaust one recovery episode;
  cross-document navigation resets it while same-document navigation does not.
- Structural pattern: follow the click describe in `tests/unit/page.test.ts` and the
  cookie-banner cases in `tests/e2e/browse.e2e.test.ts`.

## Done criteria

- [ ] A deterministic sibling/wrapper episode cannot obtain unlimited first-retry advice.
- [ ] Independent controls separated by verified progress are not conflated.
- [ ] Same-node second failure still escalates immediately.
- [ ] Only allow-listed successful operations and cross-document loader changes reset
      state; ambient `domMutated` never does.
- [ ] Every unverified hit-test path dispatches zero mouse events.
- [ ] `npm run test:unit -- tests/unit/page.test.ts tests/unit/errors.test.ts` passes.
- [ ] `npm run test:e2e` passes against real Chrome.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, and `git diff --check` pass.
- [ ] No file outside the in-scope list is modified by this plan.
- [ ] `plans/README.md` marks Plan 002 DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- The uncommitted click-hardening diff is missing, conflicts with the excerpts, or would
  need to be discarded to proceed.
- The sibling/wrapper failure cannot be reproduced deterministically, or episode state
  would require recording raw URLs, selectors or page text.
- Real Chrome reports no clear inset for the deterministic fixture; diagnose geometry
  rather than weakening hit verification.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If sampling positions change, real-browser tests should remain behavioral rather than
  pinning coordinates.
- Reviewers should scrutinize reset conditions: resetting too eagerly recreates the
  Amazon loop; resetting too late can over-escalate an unrelated control.
- The threshold is a safety/efficiency heuristic, not evidence of login or CAPTCHA.
  Detected login/challenge handling remains Plan 003's structural classifier.
