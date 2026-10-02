// ABOUTME: The human-in-the-loop handoff for a login wall or CAPTCHA. When the client renders the
// ABOUTME: inline session viewer it points a person there; otherwise it hands out the live-player URL.
import {
    CLIENT_CAPABILITIES_META_KEY,
    type ClientCapabilities,
    createRequestStateCodec,
    type InputRequiredResult,
    inputRequired,
    inputResponse,
    type RequestStateCodec,
    type ServerContext,
} from '@modelcontextprotocol/server';
import type { ServerDeps } from './context.js';
import { credentialContinuation } from './credential-continuation.js';
import {
    assessInteractiveBlock,
    type HandoffBlockEvidence,
    type InteractiveBlock,
    type InteractiveBlockKind,
    interactiveBlockError,
} from './errors.js';
import { HANDOFF_GRACE_MS } from './lifecycle.js';
import type { BrowserPage } from './page.js';
import type { HandleRecord } from './registry.js';
import { UI_EXTENSION_NAME } from './server.js';
import { stripInvisible } from './untrusted.js';

/** The key the elicitation is filed under, and the key the retry's response comes back on. */
export const HANDOFF_KEY = 'steel_human_handoff';

/**
 * How many handoffs one session may ask for before it gives up and returns the actionable error.
 *
 * The spec permits asking indefinitely. A bound is better: after three attempts the person is not
 * getting through, and a caller stuck in a loop learns nothing from a fourth identical prompt.
 *
 * Counted per handle rather than per flow, and on the handle's own record rather than in this
 * process, so the number of times a session can interrupt a person depends on neither the client
 * returning anything nor which replica happens to serve the retry.
 */
export const MAX_HANDOFF_ROUNDS = 3;

/**
 * How long idle reclamation is suspended for while a person works.
 *
 * Matches the SDK's human-paced per-leg timeout, and the registry clamps it to the handle's own
 * hard expiry, so this can never keep a slot past the session's Steel-enforced lifetime.
 */
export { HANDOFF_GRACE_MS } from './lifecycle.js';

/**
 * The state a retried call carries.
 *
 * Signed, not encrypted: the client can read every field, so nothing secret goes in. Each field is
 * here to be checked on the way back in — the handle and tool so state minted for one session and
 * verb cannot be replayed onto another, the round so a cooperative client's loop is bounded too,
 * and the origin the dialog named.
 */
export interface HandoffState {
    handle: string;
    tool: string;
    block: InteractiveBlockKind | 'sensitive_input' | 'file_upload' | 'review' | 'manual_step';
    /** The origin the dialog named, which is all of the blocked page's URL a person was shown. */
    origin: string;
    round: number;
}

/**
 * Builds the HMAC codec for the handoff state.
 *
 * The binding is the spec's user-binding MUST: state minted for one principal on one method is
 * refused when echoed under another. The binding value is stored as a keyed tag, never raw, so the
 * principal does not travel in the value the client holds.
 */
export function createHandoffCodec(secret: string): RequestStateCodec<HandoffState> {
    return createRequestStateCodec<HandoffState>({
        key: secret,
        bind: ctx => `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`,
    });
}

/**
 * The only query parameters Steel's player reads, per a probe of the live player.
 *
 * An allowlist rather than a denylist of credential-shaped names: a name list has to guess every
 * spelling and casing a deployment might use, and the parameters the player actually honours are
 * two. Anything else is dropped, so a credential cannot ride out on a name nobody thought of.
 */
const PLAYER_PARAMS = ['hideOverlay', 'hideInteractionDialog'];

/**
 * Prepares the live-player URL for the one place it is allowed to go: the elicitation payload.
 *
 * The player URL is already an unauthenticated bearer capability — whoever holds it can watch and
 * drive the browser — so it must not also carry a credential. Only the player's own parameters
 * survive, the fragment is cleared, and a URL that is not http(s) or that carries userinfo is
 * refused rather than handed to a person to open.
 */
export function handoffViewerUrl(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    // Userinfo is a credential by construction. Dropping it silently would change which server the
    // URL reaches for some clients, so a URL carrying it is not made safe, it is refused.
    if (url.username !== '' || url.password !== '') return undefined;

    const kept = new URLSearchParams();
    for (const param of PLAYER_PARAMS) {
        const value = url.searchParams.get(param);
        if (value !== null) kept.set(param, value);
    }
    url.search = kept.toString();
    // A fragment never reaches the player's server, so nothing there can be load-bearing, and it is
    // the classic place an implicit-flow token ends up.
    url.hash = '';
    return url.toString();
}

/**
 * How much of a page's origin the dialog will name.
 *
 * A hostname is capped at 253 characters and an origin a person cannot read at a glance is worse
 * than no origin at all, so anything longer is left out of the message entirely.
 */
const MAX_ORIGIN_CHARS = 100;

/**
 * Renders the blocked page's location for the dialog a person reads.
 *
 * Only the origin: a path and query are page-controlled prose, and the dialog opens a different
 * origin than the one it is describing, which is the whole setup for a phishing line in a window
 * a person trusts. `URL` punycodes the host, so what comes back is ASCII; it is invisible-stripped
 * anyway because this string is read by a person, not parsed.
 */
export function handoffOrigin(rawUrl: string): string | undefined {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const origin = stripInvisible(url.origin);
    return origin.length > MAX_ORIGIN_CHARS ? undefined : origin;
}

/**
 * Whether this request may be answered with a URL-mode elicitation.
 *
 * The per-request `_meta` envelope is the 2026-07-28 capability view; `declaredAtConnect` supplies
 * the initialize-declared capabilities an older connection has instead. A bare `elicitation: {}`
 * means form mode on the 2025 reading, so the url sub-capability must be spelled out — the same
 * rule the SDK applies before it will put the request on the wire.
 */
export function supportsUrlElicitation(
    ctx: ServerContext,
    declaredAtConnect?: () => ClientCapabilities | undefined
): boolean {
    // The SDK publishes the envelope as an opaque record, so its reserved keys are read by name.
    const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined;
    const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? declaredAtConnect?.();
    return declared?.elicitation?.url !== undefined;
}

/**
 * Whether this request may be answered with an elicitation of any kind (form or URL).
 *
 * Broader than `supportsUrlElicitation`: a bare `elicitation: {}` means form mode, which is all the
 * inline-viewer handoff needs. Read off the modern-wire per-request envelope only, since the inline
 * path it gates is itself modern-wire-only.
 */
export function supportsElicitation(ctx: ServerContext): boolean {
    const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined;
    return envelope?.[CLIENT_CAPABILITIES_META_KEY]?.elicitation !== undefined;
}

/**
 * Whether this request is being served to a client that has the inline session viewer rendered.
 *
 * The MCP-Apps UI extension is declared per request under `capabilities.extensions` on the
 * 2026-07-28 wire, and the inline viewer is a modern-wire feature, so — unlike elicitation — there
 * is no initialize-era fallback: a 2025-era connection carries no per-request capability envelope
 * and always degrades to the external player URL. The extension is the gate the whole inline path
 * keys off, because a client that renders the app is the one already on the same `session_id` the
 * viewer is showing.
 */
export function supportsInlineViewer(ctx: ServerContext): boolean {
    const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined;
    return envelope?.[CLIENT_CAPABILITIES_META_KEY]?.extensions?.[UI_EXTENSION_NAME] !== undefined;
}

/** Fixed prose per block kind. Page text is never quoted here — it would be an injection channel. */
function describeBlock(block: InteractiveBlock): string {
    return block.kind === 'login_wall'
        ? 'This page is asking someone to sign in'
        : `This page is showing a ${block.vendor} challenge`;
}

export interface HandoffRequest {
    deps: ServerDeps;
    ctx: ServerContext;
    /** The initialize-declared capabilities, for a connection with no per-request envelope. */
    declaredAtConnect?: (() => ClientCapabilities | undefined) | undefined;
    /** The public handle the caller passed, sealed into the state so it cannot be replayed. */
    handle: string;
    record: HandleRecord;
    page: BrowserPage;
    /** The tool being served, sealed into the state and checked on the way back in. */
    tool: string;
}

/**
 * Reads the live page into the evidence the one detector in `errors.ts` classifies.
 *
 * The controls travel alongside the prose because the handoff decision may not rest on wording: an
 * element that is rendered, visible and takes input is the part of a page its text cannot fake.
 */
async function pageEvidence(page: BrowserPage): Promise<HandoffBlockEvidence> {
    // Captured for detection only and never returned, so it costs CDP round trips and no tokens.
    const snapshot = await page.snapshot({});
    return {
        finalUrl: snapshot.url,
        title: snapshot.title,
        text: snapshot.nodes.map(node => `${node.role} ${node.name}`).join('\n'),
        hasPasswordField: snapshot.nodes.some(node => node.sensitive),
        controls: snapshot.nodes.map(node => ({
            role: node.role,
            name: node.name,
            sensitive: node.sensitive,
            // A ref is only issued to a node that is rendered, visible and takes pointer events,
            // so it is the snapshot's own answer to whether a person could operate this control.
            visible: node.inViewport || node.ref !== undefined,
            interactable: node.ref !== undefined,
        })),
    };
}

/** A structural block assessment that does not start or mutate a handoff round. */
export interface InteractiveBlockInspection {
    verdict: ReturnType<typeof assessInteractiveBlock>;
    finalUrl: string;
}

/** Reuses the handoff classifier without eliciting, pinning, or exposing page evidence. */
export async function inspectInteractiveBlock(page: BrowserPage): Promise<InteractiveBlockInspection> {
    const evidence = await pageEvidence(page);
    return { verdict: assessInteractiveBlock(evidence), finalUrl: evidence.finalUrl };
}

/**
 * Decides what a tool should do about a page only a person can get past.
 *
 * Returns `undefined` when the page is clear, which is also the verification result on a retry:
 * the live page is read again on every round, so the client's report that a person finished is
 * never what unblocks the call. Throws the actionable tool-execution error when a handoff cannot
 * or should not be offered — an unchanged fallback for every client that cannot elicit, and the
 * answer for a block with nothing a person could operate.
 */
export async function resolveHumanHandoff(request: HandoffRequest): Promise<InputRequiredResult | undefined> {
    const { deps, ctx, handle, record, tool } = request;
    const prior = ctx.mcpReq.requestState<HandoffState>();
    let inspection = await inspectInteractiveBlock(request.page);
    if (
        inspection.verdict?.block.kind === 'login_wall' &&
        record.mitigation.managedCredentials &&
        prior === undefined
    ) {
        const wait =
            deps.credentialGrace ??
            (signal =>
                new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        signal?.removeEventListener('abort', abort);
                        resolve();
                    }, 2_000);
                    const abort = () => {
                        clearTimeout(timer);
                        reject(new Error('credential injection wait cancelled'));
                    };
                    if (signal?.aborted) abort();
                    else signal?.addEventListener('abort', abort, { once: true });
                }));
        await wait(ctx.mcpReq.signal);
        inspection = await inspectInteractiveBlock(request.page);
    }
    const { verdict } = inspection;

    if (!verdict) return undefined;

    // Annotated on the binding, not only the arrow, so control-flow analysis knows a call ends here.
    const fail: () => never = () => {
        throw interactiveBlockError(verdict.block, inspection.finalUrl, record.mitigation);
    };

    // Page text alone is never enough to open a drivable browser to a person; the page has to hold
    // the control they would have to operate. Without one, the mitigation ladder is the answer.
    if (!verdict.clearableByPerson) fail();

    if (prior !== undefined) {
        // The state was minted by this server for this session and this verb, or it is not ours to
        // act on. Integrity, expiry and principal are already proven by the codec at the seam.
        if (prior.handle !== handle || prior.tool !== tool) fail();
        // A person who declined or cancelled is not asked twice.
        const response = inputResponse(ctx.mcpReq.inputResponses, HANDOFF_KEY);
        if (response.kind === 'elicit' && response.action !== 'accept') fail();
    }

    // Filled credentials still appear as a login wall until the site's own
    // controls finish the flow. Authorization and cancellation still apply.
    if (
        verdict.block.kind === 'login_wall' &&
        (await credentialContinuation(deps, record, request.page, ctx.mcpReq.signal))
    )
        return undefined;

    if (prior !== undefined && prior.round >= MAX_HANDOFF_ROUNDS) fail();

    // The client's round count is a courtesy; this one is the bound. It comes off the handle's own
    // record, so a client that never echoes the state — and a retry served by a replica that has
    // never seen this handle before — gets no extra prompts out of the server for it.
    const now = deps.now().getTime();
    if (record.handoffRounds >= MAX_HANDOFF_ROUNDS) fail();

    // When the create request proved the client rendered the inline session viewer, or this request
    // declares the MCP-Apps UI extension, point the person at that viewer instead of handing out the
    // external player URL. The viewer reaches the same browser through the scoped CDP token the app
    // already holds, so the unauthenticated player URL — a drive-capable bearer capability — never
    // leaves the server on this path. The retried call re-reads the page itself, exactly as the
    // external path does, so the round counter and signed state keep working unchanged.
    // The inline viewer is a modern-wire feature declared under the UI extension. It also requires
    // elicitation: a client that declared the viewer but not elicitation cannot receive the form the
    // inline path returns, so it degrades to the external player URL below rather than getting a
    // result shape it never said it could handle.
    if ((record.inlineViewer || supportsInlineViewer(ctx)) && supportsElicitation(ctx)) {
        const round = await deps.registry.recordHandoff(handle);
        const origin = handoffOrigin(inspection.finalUrl);
        const state: HandoffState = { handle, tool, block: verdict.block.kind, origin: origin ?? '', round };
        const requestState = await deps.handoffState.mint(state, ctx);
        const deadline = ` Finish before ${new Date(record.expiresAt).toISOString()}; handoff cannot extend it.`;
        // Pinned as late as the handler can: the inline path has no further gate, so a call that
        // reaches here does ask the person, and the slot survives the sweep while they work.
        await deps.registry.awaitInput(handle, Math.min(now + HANDOFF_GRACE_MS, record.expiresAt));
        return inputRequired({
            requestState,
            inputRequests: {
                [HANDOFF_KEY]: inputRequired.elicit({
                    message:
                        `${describeBlock(verdict.block)}${origin === undefined ? '' : ` on ${origin}`}. Take control ` +
                        'in the live browser viewer above and finish this step by hand. When finished, choose Hand back ' +
                        'in the viewer, then accept the pending handoff prompt. I will re-read the page and carry on ' +
                        'only if the way is actually clear.' +
                        deadline,
                    // No fields: the person signals "done" with the elicitation's accept action, and
                    // the retried call re-reads the page itself, so no structured input is needed.
                    requestedSchema: { type: 'object', properties: {} },
                }),
            },
        });
    }

    if (!supportsUrlElicitation(ctx, request.declaredAtConnect)) fail();

    const url = handoffViewerUrl(record.debugUrl);
    if (url === undefined) fail();

    const round = await deps.registry.recordHandoff(handle);
    const origin = handoffOrigin(inspection.finalUrl);
    const state: HandoffState = { handle, tool, block: verdict.block.kind, origin: origin ?? '', round };
    const requestState = await deps.handoffState.mint(state, ctx);
    const deadline = ` Finish before ${new Date(record.expiresAt).toISOString()}; handoff cannot extend it.`;

    // Set as late as the handler can: every reason to degrade to the error has been ruled out by
    // here, so a call that never asks anyone to do anything does not leave a slot pinned. The
    // client's own capability gate still runs after this handler returns, and a rejection there
    // would leave the pin in place until the handle's own expiry clears it.
    await deps.registry.awaitInput(handle, Math.min(now + HANDOFF_GRACE_MS, record.expiresAt));

    return inputRequired({
        requestState,
        inputRequests: {
            [HANDOFF_KEY]: inputRequired.elicitUrl({
                message:
                    `${describeBlock(verdict.block)}${origin === undefined ? '' : ` on ${origin}`}. Open the live ` +
                    'browser and finish this step by hand. When finished, choose Hand back in the viewer, then return ' +
                    'here and accept the pending handoff prompt. The tool re-reads the page and carries on only if ' +
                    'the way is actually clear.' +
                    deadline,
                url,
            }),
        },
    });
}
