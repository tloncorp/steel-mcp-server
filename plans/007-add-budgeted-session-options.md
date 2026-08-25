# Plan 007: Add one budgeted session planner with safe saved identity

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer dispatched you and said they maintain the
> index.
>
> **Dirty-tree gate (run before the drift check)**: `git status --short`
> This plan was written while the worktree contained uncommitted user changes
> in `README.md`, `src/core/errors.ts`, `src/core/page.ts`,
> `src/core/rate-limit.ts`, `src/core/tools/browse.ts`,
> `src/core/tools/session.ts`, `tests/integration/mrtr.test.ts`,
> `tests/integration/tools.test.ts`, `tests/unit/errors.test.ts`,
> `tests/unit/page.test.ts`, and `tests/unit/steel-rest.test.ts`. Do not start
> implementation on top of those changes unless the operator explicitly says
> they are the intended baseline. Never discard them. `src/core/page.ts` and
> its tests are out of scope and must remain untouched.
>
> **Drift check (run after the dirty-tree gate)**:
>
> ```sh
> git diff --stat c0a4e7c..HEAD -- \
>   README.md PLAN.md manifest.json tool-budgets.json \
>   src/core/context.ts src/core/errors.ts src/core/instructions.ts \
>   src/core/mrtr.ts src/core/pagination.ts src/core/profiles.ts \
>   src/core/rate-limit.ts src/core/registry.ts src/core/registry-redis.ts \
>   src/core/steel/types.ts src/core/steel/rest.ts \
>   src/core/tools/session.ts src/stdio.ts src/hosted-runtime.ts \
>   tests/helpers/fakes.ts tests/budget/tool-bytes.test.ts \
>   tests/integration/http.test.ts tests/integration/mrtr.test.ts \
>   tests/integration/tools.test.ts tests/unit/errors.test.ts \
>   tests/unit/hosted-runtime.test.ts tests/unit/mcpb-manifest.test.ts \
>   tests/unit/pagination.test.ts tests/unit/profiles.test.ts \
>   tests/unit/rate-limit.test.ts tests/unit/registry.test.ts \
>   tests/unit/registry-conformance.test.ts tests/unit/registry-redis.test.ts \
>   tests/unit/steel-rest.test.ts tests/smoke/cloud.test.ts plans/README.md
> ```
>
> Plans 002, 003, and 005 must be DONE before execution. Replace `c0a4e7c`
> with their merged HEAD and refresh every excerpt, test count, and byte
> measurement. If optional Plan 004 or independent Plan 006 landed first,
> refresh against those changes too. On a material mismatch, stop.

## Status

- **Execution status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/005-lifecycle-efficient-shopping-workflow.md`
  (transitively Plans 002 and 003); Plan 001's committed handoff core
- **Category**: direction, correctness, security
- **Planned at**: commit `c0a4e7c`, 2026-08-13

## Why this matters

The MCP can currently consume a caller-supplied saved profile ID, but it cannot
find one. It accepts a credential namespace, but the REST request omits Steel's
required `credentials` object, so no managed credential is injected. It also
cannot ask Steel to persist a new or updated profile.

Mirroring Profiles, Credentials, dedicated IPs, and the full Sessions API as
separate tools would solve discovery by making the model surface larger and
harder to use. Instead, add exactly one deterministic, progressively disclosed
`browser_session_options` tool. It recommends the smallest supported
configuration for an explicit task, returns only safe account metadata, and
mints a short-lived signed configuration consumed by the existing
`browser_session_create` tool. Advanced settings then cost response tokens only
when requested, while `tools/list` remains fixed, cacheable, and within its
existing 17,000-byte browse budget.

The intended credential path is Steel-native: the model selects safe metadata,
Steel injects stored values, snapshots redact sensitive fields, and no
password, TOTP secret, cookie, token, or credential value enters an MCP tool
argument or result.

## Product and protocol decisions

These decisions are part of the contract:

1. Add **one** model-visible tool, `browser_session_options`. Do not add separate
   profile, credential, recipe, proxy, or settings tools.
2. Keep `tools/list` deterministic and principal-independent. Account data is
   returned by a tool call; it never appears in a tool enum, description,
   prompt, resource, or cached list result.
3. Do not use sampling or a second model. Recommendation is a pure table over
   structured requirements. Do not infer paid or identity-changing settings
   from a hostname or arbitrary task prose.
4. Do not expose raw Steel JSON. Profile and credential responses are projected
   through explicit allowlists before any tool result is built.
5. Do not add an MCP `outputSchema` in this version. The internal TypeScript
   result type and tests pin the result; omitting the serialized output schema
   is a deliberate byte-budget tradeoff.
6. Use a signed, ten-minute, principal-bound `configuration` string to carry
   advanced settings from `browser_session_options` to
   `browser_session_create`. It is signed, not encrypted, so it may contain safe
   selectors and settings but never secrets or free-form task text.
7. Keep direct, simple create arguments for compatibility. Reject conflicts
   between a signed configuration and a direct override instead of silently
   choosing precedence.
8. Profiles are selected by UUID, not by invented name. Steel's current
   profile records have no trustworthy site or human-name field.
9. Credential values remain provisioned out of band through Steel's dashboard,
   CLI, or SDK. This MCP only lists metadata and activates injection.
10. Profile persistence is session-native: send `persistProfile` on session
    creation and let Steel save on every release path. Do not upload a browser
    archive or call profile create/update endpoints.
11. Keep the browser headful and the viewer interactive. Headless/Selenium
    recipes conflict with this MCP's human handoff and live-view safety model.
12. Keep `browser_session_live_view` last and app-only. Insert the new tool
    immediately before it, preserving the byte-identical prefix of the
    existing model-visible tool list.

MCP tools are the correct primitive because tools are model-controlled;
resources are application-controlled and prompts are user-controlled. Tool
completion also cannot populate ordinary tool arguments. See the current MCP
[server primitives](https://modelcontextprotocol.io/specification/2026-07-28/server/index)
and [tools contract](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

## Exact MCP contract

### `browser_session_options` input

Keep serialized Zod descriptions short; detailed guidance belongs in results.

```ts
interface SessionOptionsArgs {
    /** Absolute HTTP(S) target. It is normalized to an origin and never fetched. */
    url: string;
    goal: 'read' | 'interact' | 'account';
    needs?: Array<
        | 'long_running'
        | 'protected_text'
        | 'human_captcha'
        | 'persist_profile'
        | 'mobile'
        | 'location'
    >;
    /** Required only with long_running. */
    minutes?: number; // integer, 1..1440
    /** Required only with location. */
    country?: string; // uppercase ISO-3166 alpha-2
    /** Continue a locally paginated account catalog. */
    cursor?: string;
}
```

Validation rules:

- Accept only `http:` and `https:` URLs with no username or password. Normalize
  to `new URL(url).origin`; do not fetch it.
- `needs` must be unique and contain at most the six defined values.
- Require `minutes` exactly when `long_running` is present.
- Require `country` exactly when `location` is present.
- `protected_text` is valid only with `goal: 'read'`.
- `human_captcha` is valid only with `interact` or `account` and conflicts with
  `protected_text`.
- `persist_profile` is valid only with `goal: 'account'`.
- A default read with no session-only need recommends `browser_scrape`, not a
  billed session.

### Signed configuration

Create `src/core/session-plan.ts` with this maximum payload shape. Do not turn
it into arbitrary Steel JSON.

```ts
interface SessionPlanState {
    v: 1;
    origin: string;
    goal: 'read' | 'interact' | 'account';
    settings: {
        timeout?: number;
        useProxy?: true | { geolocation: { country: string } };
        solveCaptcha?: true;
        stealthConfig?: { autoCaptchaSolving: false };
        optimizeBandwidth?: {
            blockImages: true;
            blockMedia: true;
            blockStylesheets: false;
        };
        deviceConfig?: { device: 'mobile' };
        persistProfile?: true;
    };
    /** Allows create to validate a selected namespace against this exact origin. */
    accountContext: boolean;
}
```

Build a dedicated `RequestStateCodec<SessionPlanState>` with a ten-minute TTL.
Bind it to `steel.session-plan.v1\0${principal}`. Do not reuse the handoff codec
or its payload type. The same operator secret may back both codecs only with
the distinct binding/domain above. Call `mint` in the options handler and
`verify` manually in session creation; the server's protocol-level
`requestState.verify` remains the handoff verifier.

The token is a reusable recommendation during its short TTL, not an
authorization grant. At create time, re-read account limits and revalidate any
selected profile or credential metadata.

### `browser_session_create` additions and compatibility

Add one permanent field:

```ts
configuration?: string; // signed value from browser_session_options
```

Retain the current simple fields:

```ts
use_proxy?: boolean;
solve_captcha?: boolean;
profile_id?: string;
namespace?: string;
block_ads?: boolean;
device?: 'desktop' | 'mobile';
viewport?: { width: number; height: number };
timeout_ms?: number;
```

Rules:

- A direct field and a signed setting for the same Steel field are an
  `invalid_argument` conflict.
- `profile_id` may accompany a configuration. Revalidate it with
  `GET /v1/profiles/{id}` and require `READY` before creating.
- `namespace` may accompany an account configuration. Re-list credential
  metadata for the token's exact origin and namespace before creating. If it
  does not match, fail closed without creating a session.
- Preserve direct `namespace` for callers that already know it. Steel's fixed
  `exactOrigin: true` prevents injection on another origin even when no planner
  token is present.
- When a plan combines account candidates with a request-level proxy, warn that
  it overrides the profile's stored proxy identity. When create combines
  `profile_id` with `namespace`, warn that request-level credentials replace
  the profile's credential configuration for this session.
- Never accept a credential value, username, password, TOTP value/secret, API
  key, cookie, custom proxy URL, or raw session context.
- If `persistProfile` is true with no `profile_id`, Steel creates a profile. If
  both are present, Steel updates that profile after release. Without
  `persistProfile`, loading remains read-only.
- Before starting a persistent writer for an existing profile, acquire a
  bounded, atomic writer reservation in the handle registry. Key it by
  principal + profile UUID, fence it with the pre-minted Steel session ID, and
  expire it no later than the session hard deadline. This prevents concurrent
  writers through this MCP; document that it cannot fence an unrelated
  dashboard/SDK writer.

### Result shape

Return this internal result as `structuredContent` plus a compact text
fallback. The fallback must not duplicate a large catalog.

```ts
interface SessionOptionsResult {
    viable: boolean;
    target_origin: string;
    recommended_tool: 'browser_scrape' | 'browser_session_create';
    create_template?: {
        configuration?: string;
        namespace?: string;
        // profile_id is never guessed or represented by a fake placeholder.
    };
    scrape_arguments?: { url: string; use_proxy?: true };
    effective_defaults: {
        headless: false;
        interactive_viewer: true;
        timeout_ms: number;
        inactivity_timeout_ms: number | null;
    };
    applied_settings: Record<string, unknown>;
    rationale: string[];
    warnings: Array<{ code: string; message: string }>;
    unresolved: Array<{ field: 'profile_id' | 'namespace'; reason: string }>;
    profiles: Array<{
        profile_id: string;
        status: 'READY' | 'UPLOADING' | 'FAILED';
        created_at: string;
        updated_at: string;
    }>;
    credentials: Array<{
        namespace: string;
        origin: string;
        created_at: string;
        updated_at: string;
    }>;
    next_cursor?: string;
}
```

Do not return a profile fingerprint, user agent, dimensions, proxy settings,
extension IDs, credentials configuration, source session ID, project ID, raw
credential record, credential `value`, username, password, TOTP presence, or
any future upstream key. Omit credential labels in this first version; exact
origin plus namespace is sufficient and removes a free-text injection surface.

The profile and credential arrays contain only the current local page. Use a
fixed 20-record page and a fingerprint-bound cursor. Stable-sort profiles by
`READY` first and then `updated_at` descending; sort credentials by namespace
and then `updated_at` descending. Deduplicate credential candidates by exact
origin + namespace, keeping the newest metadata. Never auto-select a profile.
If exactly one exact-origin namespace exists for `goal: 'account'`, include it in
`create_template`; otherwise return an unresolved namespace choice.

Fingerprint the canonical normalized input plus sorted projected catalog only.
Exclude the newly minted configuration token, current time, warning prose, and
other per-call values, or every continuation call would invalidate its own
cursor. Reusing a cursor with different URL/goal/needs/country/minutes or a
changed catalog must fail as stale.

### Tool annotations and cost

```ts
annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
}
```

Set `TOOL_COSTS.browser_session_options = 3`: account plus long-running planning
may perform profile, credential, and account-details reads. It starts no
browser and consumes no concurrency slot.

## Stable recipe mapping

The user-facing guide is an input to the mapping, not a mandate to mirror the
whole Sessions API. Start from no optional setting, then add only explicitly
requested rows:

| Task request | Recommendation emitted by this MCP | Deliberate behavior |
|---|---|---|
| Plain read | `browser_scrape({url})` | Starts no billed session. |
| Standard interaction | `browser_session_create({})` | The MCP sends its configured 15-minute hard and 2-minute idle defaults, not bare Steel's five-minute default. |
| Long-running | Signed `timeout`; normal idle derivation remains active | Keep headful so viewer and handoff work; clamp to account maximum. |
| Protected text extraction | Residential proxy, CAPTCHA solving, conservative bandwidth blocking | Set only after explicit `protected_text`; keep stylesheets, block images/media. |
| CAPTCHA for a person | `solveCaptcha: true` plus `autoCaptchaSolving: false` | The existing viewer/handoff supplies human control. |
| Account without saved changes | A selected READY `profile_id`; no persistence | Profile remains read-only. |
| New persistent account profile | Signed `persistProfile: true`; no profile ID | Return the new `profileId`, release, then wait for `READY`. |
| Update persistent account profile | Signed persistence plus selected READY `profile_id` | Save occurs when any normal release path reaches Steel. |
| Managed login | Exact-origin namespace plus explicit `credentials` options | Steel injects; the model never sees or types stored values. |
| Mobile | `deviceConfig.device: 'mobile'` | Let Steel choose coherent mobile dimensions. |
| Country-targeted mobile | Mobile plus proxy geolocation country | Country is an uppercase two-letter code. |

Credential wire settings are fixed at the MCP boundary:

```ts
credentials: {
    autoSubmit: true,
    blurFields: true,
    exactOrigin: true,
}
```

This pins Steel's current defaults instead of allowing an upstream change to
weaken origin matching or field blurring. The options result must warn that a
matching login form may submit automatically. If later work needs multi-step
or no-submit login, add one semantic need to the same planner; do not add a new
tool or expose arbitrary credential configuration.

For `long_running`, omit the timeout setting when `minutes` already fits the
configured hard default. Otherwise request exactly `minutes * 60_000`, clamp it
to the reported account maximum, and explain any clamp. Always report the
inactivity timeout the create handler will derive; do not manufacture a second
idle policy in the planner.

## Explicitly deferred settings and APIs

Do not expose these in this plan:

- Dedicated/fixed IP IDs. The 2026-08-13 public OpenAPI has no list endpoint,
  so this MCP cannot reliably find the same dedicated IP. Do not claim that
  `{type:'fixed'}` without an ID preserves one identity.
- `projectId`. The caller's Steel API credential is the project/tenant
  boundary; model-controlled project switching risks cross-context confusion.
- `sessionContext`, custom/BYOP proxy servers or `proxyUrl`, raw cookies, raw
  web storage, extension IDs, custom user agents, arbitrary dimensions from a
  recipe, fingerprint bypass, arbitrary stealth settings, Selenium, headless,
  fullscreen, and region selection.
- Profile or credential create/update/delete tools; manual profile ZIP upload;
  raw credentials in form elicitation; generic `steel_request` or settings
  JSON.
- A prompt, resource, resource template, dynamic tool enum, or hostname-based
  recommendation database.
- Changes to Plan 003's automatic handoff inside `browser_batch`. Preserve its
  landed replay/boundary contract rather than redesigning it here.

## Current state

- `src/core/profiles.ts:33-50` is the fixed 15-tool browse table. The app-only
  live-view tool is last for prompt-cache stability.
- `src/core/tools/session.ts:31-40` defines eight flat create arguments.
  `profile_id` is read-only and `namespace` claims credential injection.
- `src/core/tools/session.ts:127-139` maps `namespace` but sends no
  `credentials` object.
- `src/core/tools/session.ts:193-225` returns only the opaque MCP handle and
  viewer/lifetime metadata; it does not surface Steel's `profileId`.
- `src/core/tools/session.ts:244-295` says profiles are never updated on
  release.
- `src/core/steel/types.ts:54-73` has `namespace` and `profileId`, but no
  `credentials`, `persistProfile`, geolocation proxy, bandwidth optimization,
  or CAPTCHA mode.
- `src/core/steel/types.ts:225-237` has no profile or credential account reads.
- `src/core/steel/rest.ts:181-188` spreads that incomplete create request into
  `POST /v1/sessions`.
- `src/core/mrtr.ts:250-260` classifies a login wall immediately, and
  `src/core/tools/browse.ts:90-93` invokes it immediately after navigation,
  while Steel says injection typically takes about two seconds.
- `src/core/registry.ts:18-60` stores non-secret mitigation metadata on every
  principal-authorized handle. Redis stores the same immutable marker in
  `src/core/registry-redis.ts:84-94,239-260`.
- `src/core/server.ts` caches fixed `tools/list` publicly. Principal account
  data therefore belongs only in per-call results.
- `src/core/config.ts:64-67` sets this MCP's defaults to 120,000 ms idle and
  900,000 ms hard lifetime. Creation sends them explicitly, so the planner must
  report those effective values rather than bare Steel's default.
- `tool-budgets.json` caps browse at 15 tools / 17,000 bytes and instructions
  at 2,048 bytes.
- The real budget test measured on 2026-08-13:

  ```text
  scrape:       3 tools,  3,155 bytes / 4,000
  browse:      15 tools, 16,769 bytes / 17,000
  instructions:           2,009 bytes / 2,048
  ```

- A prototype serialized through the real MCP server/client path measured the
  current `browser_session_create` at 1,920 bytes, a compact version at 1,181,
  and a compact options tool at 868. Treat these as feasibility measurements,
  not permission to skip the real post-change measurement.
- `tests/budget/tool-bytes.test.ts:22-47` measures actual `tools/list` JSON; use
  that seam, not hand-counted schema source.
- `src/core/instructions.ts` has only 39 bytes of current headroom. Detailed
  recipes belong in options results and README.
- `tests/helpers/fakes.ts:55-152` is the injected Steel API double and records
  exact calls. Extend it rather than mocking fetch in every tool test.
- `src/core/untrusted.ts:64-67` strips invisible characters. Account metadata
  is data, never prose that drives a recommendation.
- Official contracts checked on 2026-08-13:
  - [Credentials](https://docs.steel.dev/overview/credentials-api/overview.md):
    omission of `credentials` disables injection; `{}` enables defaults;
    injection is typically visible within about two seconds.
  - [Profiles](https://docs.steel.dev/overview/profiles-api/overview.md):
    `persistProfile` creates/updates on release; status moves through
    `UPLOADING` to `READY`; failed profiles cannot be used.
  - [Live OpenAPI](https://api.steel.dev/sdk-openapi.json): list/get profile,
    metadata-only credential filters, and the stable session fields used here.

## Commands you will need

Do not run `npm install` unless dependencies are missing. This plan adds none.

| Purpose | Command | Expected on success |
|---|---|---|
| Dirty baseline | `git status --short` | no unresolved in-scope user edit, or explicit operator instruction naming the baseline |
| Current budget baseline | `npm run budget` | 3 / 3,155 scrape; 15 / 16,769 browse; 2,009 instruction bytes at the planned baseline |
| Targeted unit baseline | `npx vitest run --project unit tests/unit/steel-rest.test.ts tests/unit/errors.test.ts tests/unit/rate-limit.test.ts tests/unit/profiles.test.ts tests/unit/registry-conformance.test.ts` | 5 files / 152 tests pass at the planned baseline |
| Targeted integration baseline | `npx vitest run --project integration tests/integration/tools.test.ts tests/integration/mrtr.test.ts` | 2 files / 115 tests pass at the planned baseline |
| Typecheck | `npm run typecheck` | exit 0, no TypeScript errors |
| Lint | `npm run lint` | exit 0, no Biome errors |
| Unit + integration | `npm test` | all unit and integration tests pass |
| Budgets | `npm run budget` | scrape 3 tools; browse exactly 16 and <=17,000 bytes; instructions <=2,048 |
| Build | `npm run build` | exit 0 and runnable `dist/stdio.js` produced |
| MCP conformance | `npm run conformance` | exit 0 |
| MCPB package | `npm run pack:mcpb` | exit 0 and manifest checks pass |
| Viewer regression | `npm run test:browser` | all browser tests pass; no viewer source change expected |
| Self-host E2E | `npm run test:e2e` | all self-host tests pass; cloud-only features report their limitation |

## Scope

**In scope** (the only product/test/docs files to modify):

- `src/core/session-plan.ts` (create)
- `src/core/tools/session-options.ts` (create)
- `src/core/context.ts`
- `src/core/errors.ts`
- `src/core/instructions.ts`
- `src/core/mrtr.ts`
- `src/core/pagination.ts`
- `src/core/profiles.ts`
- `src/core/rate-limit.ts`
- `src/core/registry.ts`
- `src/core/registry-redis.ts`
- `src/core/steel/types.ts`
- `src/core/steel/rest.ts`
- `src/core/tools/session.ts`
- `src/stdio.ts`
- `src/hosted-runtime.ts`
- `tests/helpers/fakes.ts`
- `tests/unit/session-plan.test.ts` (create)
- `tests/unit/steel-rest.test.ts`
- `tests/unit/errors.test.ts`
- `tests/unit/hosted-runtime.test.ts`
- `tests/unit/mcpb-manifest.test.ts`
- `tests/unit/pagination.test.ts`
- `tests/unit/profiles.test.ts`
- `tests/unit/rate-limit.test.ts`
- `tests/unit/registry.test.ts`
- `tests/unit/registry-conformance.test.ts`
- `tests/unit/registry-redis.test.ts`
- `tests/integration/tools.test.ts`
- `tests/integration/http.test.ts`
- `tests/integration/mrtr.test.ts`
- `tests/budget/tool-bytes.test.ts`
- `tests/smoke/cloud.test.ts` (feature-gated cases only)
- `README.md`
- `PLAN.md`
- `manifest.json`
- `tool-budgets.json`
- `plans/README.md` (status update only during execution)

**Out of scope** (do not touch):

- `src/core/page.ts` and `tests/unit/page.test.ts`; current click-recovery work
  belongs to the user/Plan 002.
- `src/core/tools/browse.ts`; credential grace belongs in shared handoff
  assessment, not individual page tools.
- `src/core/tools/batch.ts`; preserve Plan 003's contract.
- `src/core/apps/session-viewer.ts`; the viewer protocol does not change.
- `src/http.ts`; shared dependency injection already carries the correct
  principal-scoped API and codec.
- Package versions, release tags, deployment, or a PR.
- Any credential/profile CRUD or secret provisioning.
- Any setting listed in "Explicitly deferred settings and APIs."

## Git workflow

- Branch: `feat/session-options`
- Follow the repository's TDD rule: add failing behavioral tests before each
  production slice.
- Commit by logical phase using Conventional Commits. Suggested final commit:
  `feat(session): add budgeted identity-aware options`.
- Do not push, publish, deploy, or open a PR unless explicitly asked.

## Steps

### Step 0: Settle the baseline and re-check Steel's public contract

1. Run the dirty-tree gate. Preserve every user change. If this feature must
   build on the dirty state, have the operator commit it or name it as the
   baseline before editing overlapping files.
2. Confirm Plans 002, 003, and 005 are DONE. Refresh this plan against their
   merged HEAD and against Plans 004/006 if either landed.
3. Run the three baseline commands in the table above and replace the old
   counts/byte measurements in working notes with current results.
4. Re-fetch `https://api.steel.dev/sdk-openapi.json` and confirm:
   - `CreateSessionRequest` still has `credentials`, `namespace`,
     `persistProfile`, profile ID, geolocation proxy, `solveCaptcha`,
     `stealthConfig.autoCaptchaSolving`, `optimizeBandwidth`, and mobile device;
   - `GET /v1/profiles`, `GET /v1/profiles/{id}`, and
     `GET /v1/credentials?origin=&namespace=` still exist;
   - credential list items remain metadata-only;
   - session responses still expose `profileId`.
5. Record exact current `browser_session_create` and full browse serialized bytes
   through the budget seam before changing schemas.

**Verify**:

```sh
git status --short
npm run budget
npx vitest run --project unit tests/unit/steel-rest.test.ts tests/unit/errors.test.ts tests/unit/rate-limit.test.ts tests/unit/profiles.test.ts tests/unit/registry-conformance.test.ts
npx vitest run --project integration tests/integration/tools.test.ts tests/integration/mrtr.test.ts
```

Expected: the refreshed baseline passes and no unowned in-scope modification
will be overwritten. Stop on API drift.

### Step 1: Pin and implement the safe Steel transport boundary

Write failing tests in `tests/unit/steel-rest.test.ts` and extend
`tests/helpers/fakes.ts` before production code.

In `src/core/steel/types.ts`, add narrow types and `SteelApi` methods:

```ts
type SteelProfileStatus = 'READY' | 'UPLOADING' | 'FAILED';

interface SteelProfileSummary {
    id: string;
    status: SteelProfileStatus;
    createdAt: string;
    updatedAt: string;
}

interface SteelCredentialSummary {
    namespace: string;
    origin: string;
    createdAt: string;
    updatedAt: string;
}

interface SteelApi {
    // existing methods...
    listProfiles(signal?: AbortSignal): Promise<SteelProfileSummary[]>;
    getProfile(profileId: string, signal?: AbortSignal): Promise<SteelProfileSummary>;
    listCredentials(
        request: { origin: string; namespace?: string },
        signal?: AbortSignal
    ): Promise<SteelCredentialSummary[]>;
}
```

Add only advanced create request types represented by `SessionPlanState`:
credential flags, persistence, geolocation proxy, conservative bandwidth,
CAPTCHA auto mode, mobile device, and explicit `SteelSession.profileId`.

In `src/core/steel/rest.ts`:

- implement the GETs with `encodeURIComponent` and `URLSearchParams`;
- parse upstream payloads as unknown and construct fresh allowlisted objects;
  never spread profile or credential objects;
- drop invalid array entries, but throw `steel_error` if the top-level response
  is unusable;
- use operation `account` and preserve abort/Retry-After behavior.

Update `src/core/errors.ts` so an account-operation 429 does not claim it used
the 20-RPM Browser Tools quota. Keep concurrency/browser-tool copy unchanged.

Tests must prove:

- exact paths and percent/query encoding;
- abort propagation;
- `value`, `totpSecret`, username, fingerprint, proxy configuration,
  credentials configuration, source session, user agent, dimensions,
  extensions, project ID, and unknown keys never survive projection;
- namespace plus credential options serializes correctly;
- absence of namespace/credentials omits both;
- every signed-plan field maps to exact Steel casing;
- account 429 copy names the account API rather than Browser Tools.

**Verify**:

```sh
npx vitest run --project unit tests/unit/steel-rest.test.ts tests/unit/errors.test.ts
```

Expected: all hostile upstream fixtures pass and `SteelApi` returns no raw
account object.

### Step 2: Add the principal-bound session-plan codec

Write `tests/unit/session-plan.test.ts` first. Create
`src/core/session-plan.ts` and wire `sessionPlanState` through:

- `src/core/context.ts` (`ServerDeps`);
- `src/stdio.ts` (one fixed principal);
- `src/hosted-runtime.ts` (one codec in each tenant bundle);
- `tests/helpers/fakes.ts`.

Use the configured request-state secret and exact binding above. Do not add a
second environment variable/dependency, replace `handoffState`, or change
`src/core/server.ts`'s protocol verifier.

Tests must prove:

- mint/verify round-trip for the exact versioned payload;
- bad MAC, tampering, expiry, another principal, and cross-codec use fail;
- a token contains neither raw principal nor any fixture secret;
- hosted runtime reuses a codec only inside the correct tenant;
- no token/decoded payload is logged.

**Verify**:

```sh
npx vitest run --project unit tests/unit/session-plan.test.ts tests/unit/hosted-runtime.test.ts
```

Expected: codec and tenant-isolation tests pass; handoff-state tests remain
unchanged.

### Step 3: Implement deterministic recommendation and catalog pagination

Extend `src/core/pagination.ts` with a generic record paginator using the
existing offset + content-fingerprint cursor idea. Keep the text paginator
wire-compatible. Test first/next/final pages, ordering, malformed/stale cursors,
changed catalogs, different planner inputs, and exclusion of the freshly minted
token/time from the fingerprint in `tests/unit/pagination.test.ts`.

Then create `src/core/tools/session-options.ts`. Keep recommendation as a pure
function table-tested independently of network calls. Do not parse task prose
or maintain a hostname list.

Account behavior:

- For `goal !== 'account'`, do not list profiles/credentials.
- For account goal on cloud, fetch profiles and exact-origin credentials in
  parallel.
- Fetch account details only when `long_running` needs its maximum. On failure,
  use configured timeout and add a warning.
- A discovery failure yields an empty section plus typed warning; it does not
  erase another successful section or expose raw error text.
- If no credential matches and navigation later reveals a different login/SSO
  origin, tell the agent to call `browser_session_options` again for that
  observed origin. Never broaden matching to a parent domain or wildcard.
- On self-host, return `viable: false` for explicit cloud-only needs/account
  mode, named warnings, and no token. Plain read/interaction remains viable.
- Strip invisible characters, cap strings, and never interpolate metadata into
  recommendation instructions.
- Structured content contains current-page records only. Text summarizes
  counts/current page, never the full catalog.

Planner tests must cover:

- default read -> scrape and no token;
- default interact -> empty create template/no optional setting;
- every need and stable recipe;
- every invalid combination;
- account with zero/one/multiple exact-origin namespaces;
- READY/UPLOADING/FAILED profiles, READY first, no auto-selection;
- profile candidates combined with location/protected networking emit the
  request-overrides-profile warning;
- plan maximum below/above requested duration;
- a requested duration already covered by the configured default emits no
  redundant timeout setting;
- country validation and no target fetch;
- partial failures and self-host;
- hostile/invisible metadata and no secret-shaped key in either result form;
- first/continued catalog pages.

**Verify**:

```sh
npx vitest run --project unit tests/unit/session-plan.test.ts tests/unit/pagination.test.ts
```

Expected: the pure matrix and pagination pass before registration.

### Step 4: Register one tool and lock the byte budget immediately

Register `browser_session_options` in `src/core/profiles.ts` immediately before
`browser_session_live_view`. It belongs to `browse` only. Add it at the same
position in `manifest.json` and update exact-order tests in
`tests/unit/profiles.test.ts`, `tests/integration/tools.test.ts`, and
`tests/unit/mcpb-manifest.test.ts`.

Compact `browser_session_create` prose while preserving:

- billed/limited-concurrency browser;
- prompt release and scrape-first guidance;
- configuration comes only from options;
- persistence is opt-in;
- namespace is metadata, never a secret.

Detailed recipes move to options results/README. Do not remove safety facts to
make a number pass.

Keep aggregate limits unchanged except tool count:

```json
{
  "instructionsBytes": 2048,
  "profiles": {
    "scrape": { "tools": 3, "bytes": 4000 },
    "browse": { "tools": 16, "bytes": 17000 }
  }
}
```

Add per-tool caps and assertions:

```json
"toolBytes": {
  "browser_session_create": 1200,
  "browser_session_options": 950
}
```

Teach `tests/budget/tool-bytes.test.ts` to print/assert individual serialized
definitions. Target browse <=16,950 before merge; 17,000 is the hard ceiling.
Do not modify instructions in this step.

**Verify**:

```sh
npx vitest run --project unit tests/unit/profiles.test.ts tests/unit/mcpb-manifest.test.ts tests/unit/rate-limit.test.ts
npx vitest run --project integration tests/integration/tools.test.ts
npm run budget
```

Expected: scrape 3; browse 16 <=17,000; create <=1,200; options <=950;
instructions <=2,048; live view last/app-only. Stop rather than raise a cap or
add another tool.

### Step 5: Consume configurations, activate credentials, and persist profiles

Add failing integration tests around create/release first. In the guarded
handler:

1. Verify `configuration` with `deps.sessionPlanState`.
2. Validate direct/signed conflicts.
3. Apply self-host checks to merged settings.
4. Revalidate profile and require READY.
5. Revalidate namespace against token origin when account context exists.
6. Read plan limits, clamp timeout, and derive inactivity as today.
7. Mint the Steel session ID and atomically reserve an existing profile writer
   through the hard deadline when persistence is requested.
8. Send the exact merged Steel request.
9. Register only non-secret markers; release the reservation on every failed
   create/registration path.

When `namespace` is present, always send:

```ts
namespace: args.namespace,
credentials: { autoSubmit: true, blurFields: true, exactOrigin: true },
```

Extend `MitigationState`/handle records only with:

```ts
managedCredentials?: boolean;
profileId?: string;
persistProfile?: boolean;
```

Use `session.profileId ?? args.profile_id`. Never store namespace, origin,
catalog records, token, task requirements, proxy details, or credential values.

Extend `HandleRegistry` with a narrow writer-reservation contract rather than a
check-then-create race:

```ts
reserveProfileWriter(
    principal: string,
    profileId: string,
    ownerSteelSessionId: string,
    untilMs: number
): Promise<boolean>;
releaseProfileWriter(
    principal: string,
    profileId: string,
    ownerSteelSessionId: string
): Promise<void>;
```

The in-memory backend uses an expiring map. Redis uses `SET NX PX` and
compare-delete with a key under the existing deployment prefix. The ordinary
registry release path compare-deletes the reservation after releasing Steel;
create cleanup releases it explicitly. A stale creator cannot delete a newer
owner's reservation. A new profile needs no reservation because no shared ID
exists yet.

Create/release results must:

- return `profile_id` when Steel did;
- say whether persistence was requested and that save occurs on release;
- keep read-only profile copy when persistence is absent;
- return profile ID/persistence request on explicit release;
- say a persisted profile may be UPLOADING and must become READY;
- make no extra Profiles call on explicit, stream-close, or reaper release.

Update login-wall advice: when managed credentials were enabled but login
remains, verify exact origin/namespace or use handoff. Never request a password.

Tests cover basic unchanged create, direct namespace activation, mismatched
origin/namespace fail-before-create, token security, every conflict, self-host,
read-only profile, create-new/update persistence, non-READY profiles, atomic
writer contention/expiry/fencing, every release path, both registries, and
absence of secret metadata in results/state.

**Verify**:

```sh
npx vitest run --project unit tests/unit/registry.test.ts tests/unit/registry-conformance.test.ts tests/unit/registry-redis.test.ts tests/unit/steel-rest.test.ts tests/unit/errors.test.ts
npx vitest run --project integration tests/integration/tools.test.ts tests/integration/http.test.ts
```

Expected: all pass; two-principal HTTP coverage proves catalog/profile
isolation.

### Step 6: Give Steel one bounded credential-injection grace period

Preserve the handoff/batch behavior landed by Plans 001, 003, and 005. In
`src/core/mrtr.ts`, when the initial assessment for one tool call is a login
wall and `record.mitigation.managedCredentials` is true:

1. wait 2,000 ms with an abort-aware timer;
2. recapture evidence exactly once;
3. continue if the wall cleared;
4. otherwise use the existing signed handoff/error path.

Do not sleep for sessions without managed credentials, CAPTCHA/non-login pages,
or a handoff retry carrying request state. Do not loop or inspect secret field
values; use only a fresh redacted snapshot.

Use fake timers in `tests/integration/mrtr.test.ts`. Cover delayed redirect,
wrong namespace, abort, no-credential behavior, no second wait on retry, and no
secret in results/logs.

**Verify**:

```sh
npx vitest run --project integration tests/integration/mrtr.test.ts tests/integration/tools.test.ts
```

Expected: all prior handoff/batch boundary assertions remain green; the only
delay is mocked credential grace.

### Step 7: Teach the agent and package without expanding the global prompt

Add one concise instruction:

```text
For non-default setup, call browser_session_options with the target URL and
explicit needs, then pass its signed configuration to browser_session_create.
```

Trim duplicated setup prose so instructions target <=2,000 bytes while
retaining all current scrape-first, release/expiry, ref/snapshot, safe batch,
handoff/sensitive/file/exclusive-control, and untrusted-content requirements.
Do not move recipes into instructions.

Update:

- `README.md` with a decision table, options/create example, profile lifecycle,
  managed-credential non-disclosure, self-host limits, and ID/namespace source;
- `PLAN.md` to replace old consume-only/inert-namespace statements while
  keeping credential CRUD excluded;
- `manifest.json` browse count and tool summary;
- instruction and manifest tests.

Docs must distinguish `STEEL_PROFILE=browse|scrape` (tool preset) from saved
browser profiles and state: cloud-only statuses, persistence-after-release,
credential values never in context, actual configured 15m/2m defaults, and
fixed-IP/deferred settings absent.

**Verify**:

```sh
npx vitest run --project integration tests/integration/tools.test.ts
npx vitest run --project unit tests/unit/mcpb-manifest.test.ts
npm run budget
```

Expected: instructions <=2,000 target (2,048 hard), browse <=17,000, and all
security/handoff assertions remain.

### Step 8: Run complete verification and optional cloud proof

**Verify**:

```sh
npm run typecheck
npm run lint
npm test
npm run budget
npm run build
npm run conformance
npm run pack:mcpb
npm run test:browser
npm run test:e2e
```

Expected: every command exits 0. Self-host E2E must not attempt cloud account
reads/persistence; it returns planned capability guidance.

Cloud smoke is optional and must use an operator-provisioned synthetic
origin/namespace/profile. Gate new cases behind explicit fixture variables. A
credential smoke lists metadata, creates with the synthetic namespace,
navigates to its synthetic origin, observes login success, and releases. It
must never print/assert a stored value.

Profile persistence smoke is more destructive because current public API has
no profile delete. Run only after explicit approval. It may create a synthetic
profile, release, poll safe metadata until READY, reuse read-only once, and
print only UUID/status for cleanup or natural expiry. Do not run merely because
`STEEL_API_KEY` exists.

If approved:

```sh
STEEL_API_KEY=... \
STEEL_SMOKE_ORIGIN=https://synthetic.example \
STEEL_SMOKE_NAMESPACE=synthetic \
npm run test:smoke
```

Expected: only synthetic cases run; no secret/player URL enters output.

## Test plan

The step-level tests are mandatory. Review these cross-layer properties:

### Correctness

- Planner create templates are accepted by the registered create schema.
- Default planning adds no paid/identity setting.
- Every setting is justified by one explicit goal/need.
- Steel wire includes `credentials` whenever namespace injection is used.
- Profile create/update uses release and returns profile ID/status guidance.
- The two-second grace occurs once per initial credential login assessment.

### Security and tenancy

- Account responses are projected before model exposure.
- Values/TOTP/raw records never appear in result, registry, trace, or error.
- URL normalization rejects userinfo/non-HTTP and performs no target fetch.
- Configuration rejects tampering, expiry, cross-principal/cross-codec use.
- Hosted principals receive only their own catalogs.
- No module/global cache stores account data.

### Surface and budget

- Scrape stays 3 tools; browse becomes 16.
- No second tool/resource/prompt is added.
- Order is stable; live view stays last/app-only.
- Browse <=17,000; options <=950; create <=1,200.
- Instructions <=2,048, target <=2,000.

## Done criteria

- [ ] Plans 002, 003, and 005 were DONE and this plan was refreshed against
      their merged baseline without discarding user changes.
- [ ] Current Steel contracts support every selected field/projection.
- [ ] `browser_session_options` is the only new model-visible tool.
- [ ] Planner is deterministic with no hostname/task-prose heuristic or fetch.
- [ ] Correct principal can discover profiles/namespaces safely.
- [ ] Namespace injection sends explicit credential flags and no secret.
- [ ] New/update/read-only profile lifecycles work as specified.
- [ ] Credential login gets one abort-aware grace recheck.
- [ ] Fixed IP and other deferred settings remain absent.
- [ ] Typecheck, lint, all tests, budget, build, conformance, MCPB, browser, and
      E2E commands exit 0.
- [ ] Scrape is 3 tools; browse is 16 and <=17,000 bytes.
- [ ] Per-tool/instruction caps pass.
- [ ] No file outside scope is modified.
- [ ] `plans/README.md` marks Plan 007 DONE or BLOCKED with reason.

## STOP conditions

Stop and report; do not improvise if:

1. Plans 002/003/005 are not DONE, an in-scope user change remains dirty
   without instruction, or live code materially differs.
2. Steel contracts no longer support credential activation, persistence,
   returned profile ID/status, or exact metadata endpoints.
3. Credential list data cannot be strictly projected before model exposure.
4. Persistence does not complete through native release or profile ID is absent.
5. Existing-profile persistence cannot be protected by the bounded
   principal/profile reservation described here, or Steel requires stronger
   cross-client locking. Keep create-new persistence and report the limitation.
6. A recommendation needs hostname heuristics, target probing, sampling, or a
   second model.
7. The feature needs another model-visible tool, dynamic `tools/list`,
   prompt/resource indirection, or generic Steel JSON.
8. Browse exceeds 17,000, options 950, create 1,200, or instructions 2,048
   after concise prose. Do not raise a cap or weaken safety guidance.
9. Dedicated IP needs an ID the public account API cannot list.
10. Any result/state/trace/error/fixture/token would contain a credential
    value, API key, TOTP secret, cookie, player URL, proxy credential, or raw
    profile archive.
11. Verification fails twice after one focused correction, or a fix requires
    an out-of-scope file.

## Maintenance notes

- Re-check live OpenAPI whenever adding a recipe. Stable in Steel does not
  automatically mean appropriate for an agent-facing MCP.
- Keep READY validation/lifecycle copy aligned with Steel's profile limits and
  expiry policy.
- The signed plan is progressive disclosure, not authorization; revalidate
  mutable account state at create time.
- If output schemas become necessary, measure and obtain a reviewed budget
  change; do not add one invisibly.
- If Steel adds metadata-only dedicated-IP listing, extend this same tool/token;
  do not default to a new tool.
- If no-submit/multi-step login is needed, add one semantic planner need and
  keep `blurFields`/`exactOrigin` fixed true.
- Review strict projections, codec binding, merge conflicts, principal
  isolation, release semantics, and real serialized bytes especially closely.
