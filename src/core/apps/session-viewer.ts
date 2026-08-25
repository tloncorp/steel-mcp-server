// ABOUTME: The MCP-App session viewer: one static HTML app that paints a live Steel browser onto a
// ABOUTME: canvas over CDP, exported as a string together with the pure helpers its script runs.
import { SERVER_VERSION } from '../version.js';

/** The `ui://` resource URI the app is served under. */
export const SESSION_VIEWER_URI = 'ui://browser/session-viewer';

/** MIME type `resources/read` must report for a host to render the app as an MCP App. */
export const SESSION_VIEWER_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * The app-only tool the app calls, with `{ session_id }`, to get its connection details.
 *
 * Its `structuredContent` answers `{ cdp_url, viewport: { width, height }, expires_at }`. `cdp_url`
 * is a drive-capable credential: it is validated, opened, and never rendered, logged or put in the
 * DOM. See `validateCdpUrl` and `scrubCredentials`.
 */
export const SESSION_VIEWER_LIVE_VIEW_TOOL = 'browser_session_live_view';

/**
 * Message the app posts to its parent once its host handshake is done.
 *
 * The MCP Apps bridge already tells a conforming host when the app is ready
 * (`ui/notifications/initialized`); this is the plain-postMessage echo of the same fact, so a test
 * harness or a non-MCP embedder can wait for the app without speaking JSON-RPC.
 */
export const SESSION_VIEWER_READY_MESSAGE_TYPE = 'steel-mcp:viewer-ready';

/**
 * How long with no frame before the app says the page is idle rather than live.
 *
 * A screencast is repaint-driven, not a frame rate: a page that is not changing sends nothing at
 * all. The viewer must not read that as a fault, so this is the boundary between "painting" and
 * "connected, page idle", never between working and broken.
 */
export const SESSION_VIEWER_IDLE_AFTER_MS = 1500;

/** A validated CDP socket URL and the host it is pinned to for the rest of the app's life. */
export interface CdpTarget {
    readonly url: string;
    readonly host: string;
}

/**
 * Validates a CDP socket URL and returns it unchanged plus its host, or `null`.
 *
 * The URL arrives at runtime from a tool result and carries a token that can drive the browser, so
 * it is checked before a socket is opened: `wss:` only, no userinfo (`wss://connect.steel.dev@evil`
 * reads as the expected host), and once a host has been accepted every later URL must match it, so
 * a second call cannot move the app to another origin. The string is returned byte for byte because
 * the query is the credential and must reach Steel exactly as issued.
 *
 * Runs both in Node (tested) and in the app, where it is embedded by source, so its body must
 * reference nothing outside itself.
 */
export function validateCdpUrl(raw: unknown, pinnedHost: string | null): CdpTarget | null {
    if (typeof raw !== 'string' || raw === '') return null;
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'wss:') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    if (parsed.hostname === '') return null;
    if (pinnedHost !== null && parsed.host !== pinnedHost) return null;
    return { url: raw, host: parsed.host };
}

/**
 * Strips credentials out of a message before it is shown, and truncates it.
 *
 * Every string the app displays goes through this: socket URLs lose their query, credential
 * parameters and JWTs are replaced. A token must never reach the DOM, not even inside an error
 * message the browser or the host wrote.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function scrubCredentials(text: unknown): string {
    if (typeof text !== 'string') return '';
    return text
        .replace(/(wss?:\/\/[^\s?#]*)[?#][^\s]*/gi, '$1')
        .replace(/\b(token|apiKey|api_key|access_token|steel-api-key)=[^\s&]*/gi, '$1=<redacted>')
        .replace(/\bey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '<redacted>')
        .slice(0, 200);
}

/**
 * Reads `session_id` out of a tool result the host pushed to the app, or `null`.
 *
 * The id is already in the conversation, so it is not sensitive; it is still shape-checked because
 * it goes straight back out as a tool argument. Any result without one — another tool's, or one
 * with no structured content — is ignored rather than guessed at.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function readSessionIdFromToolResult(result: unknown): string | null {
    if (typeof result !== 'object' || result === null) return null;
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (typeof structured !== 'object' || structured === null) return null;
    const id = (structured as { session_id?: unknown }).session_id;
    if (typeof id !== 'string') return null;
    return /^[A-Za-z0-9_-]{4,128}$/.test(id) ? id : null;
}

/** What the live-view tool tells the app: where to connect, how big the page is, when access ends. */
export interface LiveView {
    readonly sessionId: string;
    readonly cdpUrl: string;
    /** Captured viewport width in CSS pixels, or `0` when the tool did not say. */
    readonly width: number;
    /** Captured viewport height in CSS pixels, or `0` when the tool did not say. */
    readonly height: number;
    /** Epoch milliseconds the access window ends, or `null` when the tool did not say. */
    readonly expiresAt: number | null;
}

/**
 * Reads the live-view tool's connection details, or `null` when it returned none.
 *
 * The expiry is accepted as an ISO timestamp, epoch milliseconds or epoch seconds and normalised to
 * milliseconds; an unusable viewport or expiry is reported as unknown rather than invented, because
 * the app says "expired" only when it actually knows the window has passed.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function readLiveView(result: unknown): LiveView | null {
    if (typeof result !== 'object' || result === null) return null;
    if ((result as { isError?: unknown }).isError === true) return null;
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (typeof structured !== 'object' || structured === null) return null;
    const fields = structured as { session_id?: unknown; cdp_url?: unknown; viewport?: unknown; expires_at?: unknown };
    if (typeof fields.session_id !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(fields.session_id)) return null;
    if (typeof fields.cdp_url !== 'string' || fields.cdp_url === '') return null;
    const viewport = (typeof fields.viewport === 'object' && fields.viewport !== null ? fields.viewport : {}) as {
        width?: unknown;
        height?: unknown;
    };
    const size = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 16384 ? Math.round(value) : 0;
    let expiresAt: number | null = null;
    if (typeof fields.expires_at === 'string') {
        const parsed = Date.parse(fields.expires_at);
        if (Number.isFinite(parsed)) expiresAt = parsed;
    } else if (typeof fields.expires_at === 'number' && Number.isFinite(fields.expires_at) && fields.expires_at > 0) {
        expiresAt =
            fields.expires_at < 100000000000 ? Math.round(fields.expires_at * 1000) : Math.round(fields.expires_at);
    }
    return {
        sessionId: fields.session_id,
        cdpUrl: fields.cdp_url,
        width: size(viewport.width),
        height: size(viewport.height),
        expiresAt,
    };
}

export interface ViewerControlLease {
    token: string;
    leaseExpiresAt: number;
}

/** Reads the opaque control token returned only to this app. Embedded into the viewer by source. */
export function readControlLease(result: unknown): ViewerControlLease | null {
    if (typeof result !== 'object' || result === null) return null;
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (typeof structured !== 'object' || structured === null) return null;
    const control = (structured as { control?: unknown }).control;
    if (typeof control !== 'object' || control === null) return null;
    const fields = control as { state?: unknown; token?: unknown; lease_expires_at?: unknown };
    if (fields.state !== 'human' || typeof fields.token !== 'string' || fields.token === '') return null;
    if (typeof fields.lease_expires_at !== 'string') return null;
    const leaseExpiresAt = Date.parse(fields.lease_expires_at);
    return Number.isFinite(leaseExpiresAt) ? { token: fields.token, leaseExpiresAt } : null;
}

/**
 * Reads the message off a tool result that reports failure, or `null` when it succeeded.
 *
 * A failed `tools/call` resolves with `isError: true` rather than rejecting, so without this the app
 * would report "no usable details" when the tool had already said something more useful.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function readToolErrorText(result: unknown): string | null {
    if (typeof result !== 'object' || result === null) return null;
    if ((result as { isError?: unknown }).isError !== true) return null;
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
        if (typeof block === 'object' && block !== null) {
            const text = (block as { type?: unknown; text?: unknown }).text;
            if ((block as { type?: unknown }).type === 'text' && typeof text === 'string' && text !== '') return text;
        }
    }
    return null;
}

/**
 * Parses one socket message into an object, or `null`.
 *
 * Binary frames and oversized payloads are refused outright: everything CDP sends the app is JSON,
 * and a screencast frame of a full viewport is orders of magnitude below the cap.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function parseSocketMessage(raw: unknown): object | null {
    if (typeof raw !== 'string' || raw.length > 2000000) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
}

/** A reply to one CDP command, with any failure already reduced to a message. */
export interface CdpReply {
    readonly id: number;
    readonly result: unknown;
    readonly errorMessage: string | null;
}

/**
 * Reads a CDP command reply, or `null` when the message is an event instead.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function readCdpReply(message: unknown): CdpReply | null {
    if (typeof message !== 'object' || message === null) return null;
    const frame = message as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof frame.id !== 'number') return null;
    if (typeof frame.error === 'object' && frame.error !== null) {
        const reported = (frame.error as { message?: unknown }).message;
        return {
            id: frame.id,
            result: null,
            errorMessage:
                typeof reported === 'string' && reported !== '' ? reported : 'the browser refused the command',
        };
    }
    if (!('result' in frame)) return null;
    return { id: frame.id, result: frame.result, errorMessage: null };
}

/** A remote file input Chrome asked the controlling person to populate. */
export interface FileChooserTarget {
    readonly backendNodeId: number;
}

/** Reads only the node id from Chrome's trusted file-chooser event. Embedded into the app by source. */
export function readFileChooserTarget(message: unknown): FileChooserTarget | null {
    if (typeof message !== 'object' || message === null) return null;
    const event = message as { method?: unknown; params?: unknown };
    if (event.method !== 'Page.fileChooserOpened' || typeof event.params !== 'object' || event.params === null) {
        return null;
    }
    const backendNodeId = (event.params as { backendNodeId?: unknown }).backendNodeId;
    return typeof backendNodeId === 'number' && Number.isInteger(backendNodeId) && backendNodeId > 0
        ? { backendNodeId }
        : null;
}

/** The screencast frame metadata the coordinate mapping needs, all of it verified present. */
export interface ScreencastMetadata {
    readonly offsetTop: number;
    readonly pageScaleFactor: number;
    readonly deviceWidth: number;
    readonly deviceHeight: number;
    readonly scrollOffsetX: number;
    readonly scrollOffsetY: number;
}

/** One decoded screencast frame: what to draw, what to ack with, and where the page was. */
export interface ScreencastFrame {
    /**
     * The frame's own session id, which `Page.screencastFrameAck` must echo or the stream stalls.
     *
     * Chrome types this as an `int32` on both the event and the ack command, and refuses an ack
     * carrying anything else, so it stays a number all the way back out.
     */
    readonly ackSessionId: number;
    readonly dataUrl: string;
    readonly metadata: ScreencastMetadata;
}

/**
 * Reads a `Page.screencastFrame` event into something drawable, or `null`.
 *
 * The payload is checked to be plain base64 before it is put in a `data:` URL, so no attacker-chosen
 * MIME type, comma or semicolon can escape into it, and the metadata is checked to be finite and
 * positive so the coordinate mapping cannot divide by zero later.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function readScreencastFrame(message: unknown): ScreencastFrame | null {
    if (typeof message !== 'object' || message === null) return null;
    const event = message as { method?: unknown; params?: unknown };
    if (event.method !== 'Page.screencastFrame') return null;
    if (typeof event.params !== 'object' || event.params === null) return null;
    const params = event.params as { data?: unknown; sessionId?: unknown; metadata?: unknown };
    if (typeof params.data !== 'string' || params.data.length % 4 !== 0) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(params.data)) return null;
    if (typeof params.sessionId !== 'number' || !Number.isInteger(params.sessionId)) return null;
    if (params.sessionId < 0 || params.sessionId > 2147483647) return null;
    if (typeof params.metadata !== 'object' || params.metadata === null) return null;
    const raw = params.metadata as Partial<ScreencastMetadata>;
    const finite = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) ? value : null;
    const offsetTop = finite(raw.offsetTop);
    const pageScaleFactor = finite(raw.pageScaleFactor);
    const deviceWidth = finite(raw.deviceWidth);
    const deviceHeight = finite(raw.deviceHeight);
    const scrollOffsetX = finite(raw.scrollOffsetX);
    const scrollOffsetY = finite(raw.scrollOffsetY);
    if (offsetTop === null || pageScaleFactor === null || scrollOffsetX === null || scrollOffsetY === null) return null;
    if (deviceWidth === null || deviceHeight === null) return null;
    if (deviceWidth <= 0 || deviceHeight <= 0 || pageScaleFactor <= 0) return null;
    return {
        ackSessionId: params.sessionId,
        dataUrl: `data:image/jpeg;base64,${params.data}`,
        metadata: { offsetTop, pageScaleFactor, deviceWidth, deviceHeight, scrollOffsetX, scrollOffsetY },
    };
}

/**
 * Picks the page target to screencast out of a `Target.getTargets` reply, or `null`.
 *
 * Only `type === 'page'` can be screencast, and DevTools and extension pages are skipped because
 * they are not the page the agent is driving.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function pickPageTargetId(result: unknown): string | null {
    if (typeof result !== 'object' || result === null) return null;
    const targets = (result as { targetInfos?: unknown }).targetInfos;
    if (!Array.isArray(targets)) return null;
    for (const target of targets) {
        if (typeof target !== 'object' || target === null) continue;
        const info = target as { type?: unknown; targetId?: unknown; url?: unknown };
        if (info.type !== 'page' || typeof info.targetId !== 'string' || info.targetId === '') continue;
        const url = typeof info.url === 'string' ? info.url : '';
        if (url.startsWith('devtools://') || url.startsWith('chrome-extension://')) continue;
        return info.targetId;
    }
    return null;
}

/**
 * Reads the flat session id off a `Target.attachToTarget` reply, or `null`.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function readAttachedSessionId(result: unknown): string | null {
    if (typeof result !== 'object' || result === null) return null;
    const sessionId = (result as { sessionId?: unknown }).sessionId;
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
}

/** A JSON-RPC response to one of the app's own bridge requests. */
export interface BridgeResponse {
    readonly id: number | string;
    readonly result: unknown;
    readonly error: unknown;
}

/**
 * Reads a JSON-RPC response to one of the app's bridge requests, or `null`.
 *
 * A request carrying a `method` is never a response, which matters because a same-window post is
 * echoed back to the app itself.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function readBridgeResponse(data: unknown): BridgeResponse | null {
    if (typeof data !== 'object' || data === null) return null;
    const message = data as { jsonrpc?: unknown; id?: unknown; method?: unknown; result?: unknown; error?: unknown };
    if (message.jsonrpc !== '2.0' || 'method' in message) return null;
    if (typeof message.id !== 'number' && typeof message.id !== 'string') return null;
    if (!('result' in message) && !('error' in message)) return null;
    return { id: message.id, result: message.result ?? null, error: message.error ?? null };
}

/**
 * Reads the params off a `ui/notifications/tool-result` push, or `null`.
 *
 * This is the only host message the app takes data from, and only as a notification: a message with
 * an id is a request and is answered elsewhere, never mined for a session.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function readToolResultNotification(data: unknown): object | null {
    if (typeof data !== 'object' || data === null) return null;
    const message = data as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (message.jsonrpc !== '2.0' || message.method !== 'ui/notifications/tool-result') return null;
    if (message.id !== undefined) return null;
    if (typeof message.params !== 'object' || message.params === null) return null;
    return message.params;
}

/**
 * Reads the id of a `ui/resource-teardown` request so it can be answered, or `null`.
 *
 * The host sends this before it removes the app, and it is the app's cue to stop the screencast and
 * close the socket rather than leave a stream running against a view nobody can see.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function readTeardownRequest(data: unknown): { id: number | string } | null {
    if (typeof data !== 'object' || data === null) return null;
    const message = data as { jsonrpc?: unknown; id?: unknown; method?: unknown };
    if (message.jsonrpc !== '2.0' || message.method !== 'ui/resource-teardown') return null;
    if (typeof message.id !== 'number' && typeof message.id !== 'string') return null;
    return { id: message.id };
}

/** A point in the live page, in CSS pixels: relative to the viewport, and to the document. */
export interface PagePoint {
    /** What `Input.dispatchMouseEvent` takes: CSS pixels from the top left of the viewport. */
    readonly viewportX: number;
    readonly viewportY: number;
    /** The same point in document space, scroll included. */
    readonly pageX: number;
    readonly pageY: number;
}

/**
 * Maps a point on the rendered canvas to a point in the live page, or `null` if it maps nowhere.
 *
 * The canvas holds the JPEG at its natural pixel size and is displayed contained in its box, so the
 * frame is scaled by `min(box/device)` and centred, leaving letterbox bars on one axis. Undoing that
 * gives a point in the captured frame's device-independent pixels; dividing by `pageScaleFactor` and
 * subtracting `offsetTop` (the height of the browser's own top chrome inside the capture) gives
 * viewport CSS pixels, and adding the scroll offsets gives document CSS pixels. A point in the
 * letterbox is not in the page at all and returns `null`, so a click there can never be forwarded.
 *
 * Pure, tested here, and embedded into the app by source; its body must reference nothing outside
 * itself.
 */
export function mapCanvasPointToPage(
    point: { x: number; y: number },
    box: { width: number; height: number },
    metadata: ScreencastMetadata
): PagePoint | null {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    if (!(box.width > 0) || !(box.height > 0)) return null;
    if (!(metadata.deviceWidth > 0) || !(metadata.deviceHeight > 0) || !(metadata.pageScaleFactor > 0)) return null;
    const scale = Math.min(box.width / metadata.deviceWidth, box.height / metadata.deviceHeight);
    if (!(scale > 0)) return null;
    const deviceX = (point.x - (box.width - metadata.deviceWidth * scale) / 2) / scale;
    const deviceY = (point.y - (box.height - metadata.deviceHeight * scale) / 2) / scale;
    if (deviceX < 0 || deviceY < 0 || deviceX > metadata.deviceWidth || deviceY > metadata.deviceHeight) return null;
    const viewportX = deviceX / metadata.pageScaleFactor;
    const viewportY = (deviceY - metadata.offsetTop) / metadata.pageScaleFactor;
    return {
        viewportX: Math.round(viewportX),
        viewportY: Math.round(viewportY),
        pageX: Math.round(metadata.scrollOffsetX + viewportX),
        pageY: Math.round(metadata.scrollOffsetY + viewportY),
    };
}

/**
 * Everything the viewer can honestly be in.
 *
 * `idle` is the one that has to be said carefully: a screencast is repaint-driven, so a page that is
 * not changing sends no frames at all. `expired` is the one a user can act on.
 */
export type ViewerPhase =
    | 'handshake-failed'
    | 'awaiting-session'
    | 'live-view-failed'
    | 'connecting'
    | 'awaiting-first-frame'
    | 'painting'
    | 'idle'
    | 'closed'
    | 'expired';

/** What the app knows when it decides what to show. */
export interface ViewerObservation {
    /** The phase the last lifecycle event put the app in. */
    readonly phase: ViewerPhase;
    /** When the last frame was painted, or `null` if none ever was. */
    readonly lastFrameAt: number | null;
    readonly now: number;
    readonly expiresAt: number | null;
    readonly idleAfterMs: number;
}

/**
 * Turns the app's last lifecycle event and its clock into the phase to display.
 *
 * Two facts only this can see: an elapsed `expires_at` explains every connection-stage symptom
 * better than the symptom does, and a stream with no recent frame is an idle page rather than a
 * fault. Failures from before the connection are left alone — the expiry did not cause them.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function resolveViewerPhase(observation: ViewerObservation): ViewerPhase {
    const connected =
        observation.phase === 'connecting' ||
        observation.phase === 'awaiting-first-frame' ||
        observation.phase === 'painting' ||
        observation.phase === 'idle' ||
        observation.phase === 'closed';
    if (connected && observation.expiresAt !== null && observation.now >= observation.expiresAt) return 'expired';
    if (observation.phase !== 'painting' && observation.phase !== 'idle') return observation.phase;
    if (observation.lastFrameAt === null) return 'awaiting-first-frame';
    return observation.now - observation.lastFrameAt >= observation.idleAfterMs ? 'idle' : 'painting';
}

/** What to show for a phase: whether anything is in flight, and what to say about it. */
export interface ViewerStatus {
    readonly busy: boolean;
    readonly headline: string;
    readonly detail: string;
}

/**
 * The words for each phase. The app may replace `detail` with a scrubbed message from the failure.
 *
 * Embedded into the app by source; must reference nothing outside itself.
 */
export function describeViewerPhase(phase: ViewerPhase): ViewerStatus {
    switch (phase) {
        case 'handshake-failed':
            return {
                busy: false,
                headline: 'This app could not reach the chat host',
                detail: 'The MCP Apps handshake did not complete, so it cannot ask for a live view.',
            };
        case 'live-view-failed':
            return {
                busy: false,
                headline: 'The live view is unavailable',
                detail: 'The browser service returned no live view for this session.',
            };
        case 'connecting':
            return { busy: true, headline: 'Connecting to the browser', detail: '' };
        case 'awaiting-first-frame':
            return { busy: true, headline: 'Waiting for the first frame', detail: 'The page has not repainted yet.' };
        case 'painting':
            return { busy: false, headline: 'Live', detail: '' };
        case 'idle':
            return {
                busy: false,
                headline: 'Live, page idle',
                detail: 'Frames arrive only when the page repaints, so a page that is not changing sends none.',
            };
        case 'closed':
            return {
                busy: false,
                headline: 'The live view disconnected',
                detail: 'The connection to the browser closed. The session may have ended.',
            };
        case 'expired':
            return {
                busy: false,
                headline: 'This live view expired',
                detail: 'Its access window has passed. Start a new session to watch again.',
            };
        // 'awaiting-session' and anything unrecognised: the app is waiting on the host, not broken.
        default:
            return { busy: true, headline: 'Waiting for a browser session', detail: '' };
    }
}

/** One CDP command the app forwards: a method name and its params object, nothing else. */
export interface CdpCommand {
    readonly method: string;
    readonly params: Record<string, unknown>;
}

/**
 * Maps a DOM mouse-event `button` index to the button string CDP takes.
 *
 * The DOM numbers buttons 0/1/2 for left/middle/right and 3/4 for back/forward; CDP names the first
 * three and uses `'none'` for an event with no button. Back and forward collapse to `'none'` rather
 * than a string the page-scoped `Input` dispatch does not need.
 *
 * Pure, unit-tested, and embedded into the app by source; its body references nothing outside itself.
 */
export function mapMouseButton(button: unknown): 'left' | 'right' | 'middle' | 'none' {
    if (button === 0) return 'left';
    if (button === 1) return 'middle';
    if (button === 2) return 'right';
    return 'none';
}

/**
 * The CDP button-state bitmask, clamped to the five bits Chrome defines.
 *
 * The DOM already maintains `MouseEvent.buttons` as exactly this bitmask (1 left, 2 right, 4 middle,
 * 8 back, 16 forward); this only has to refuse a value that is not a finite non-negative integer and
 * drop anything beyond the five real button bits.
 *
 * Pure, unit-tested, and embedded into the app by source; its body references nothing outside itself.
 */
export function mouseButtonsBitmask(buttons: unknown): number {
    if (typeof buttons !== 'number' || !Number.isFinite(buttons) || buttons < 0) return 0;
    return Math.floor(buttons) & 31;
}

/**
 * The click count a DOM event carries (2 for a double click), or a single click.
 *
 * `MouseEvent.detail` is the count the browser already keeps across a burst of clicks, so it is read
 * verbatim and a malformed or missing value falls back to one rather than to zero.
 *
 * Pure, unit-tested, and embedded into the app by source; its body references nothing outside itself.
 */
export function inferClickCount(detail: unknown): number {
    if (typeof detail !== 'number' || !Number.isInteger(detail) || detail < 1) return 1;
    return detail;
}

/**
 * A scroll delta in CSS pixels, which is what CDP's `mouseWheel` takes.
 *
 * A DOM `WheelEvent` is only in pixels when `deltaMode === 0`; mode 1 is lines and mode 2 is pages,
 * which on some mice (notably Windows) would otherwise arrive as single-digit pixel counts and scroll
 * almost nothing. The line- and page-height conversions are the conventional approximation browsers
 * and automation libraries use, not an exact standard: 16 px per line, ~20 lines per page. Pure,
 * unit-tested, and embedded by source; references nothing outside itself.
 */
export function wheelDelta(
    event: { deltaX?: unknown; deltaY?: unknown; deltaMode?: unknown },
    axis: 'deltaX' | 'deltaY'
): number {
    const raw = Number(event[axis]);
    if (!Number.isFinite(raw)) return 0;
    const mode = Number(event.deltaMode);
    if (mode === 1) return Math.round(raw * 16);
    if (mode === 2) return Math.round(raw * 320);
    return raw || 0;
}

/**
 * The CDP modifier bitmask (alt 1, ctrl 2, meta 4, shift 8) from a DOM event's modifier flags.
 *
 * Pure, unit-tested, and embedded into the app by source; its body references nothing outside itself.
 */
export function modifiersBitmask(event: {
    altKey?: unknown;
    ctrlKey?: unknown;
    metaKey?: unknown;
    shiftKey?: unknown;
}): number {
    let mask = 0;
    if (event.altKey) mask |= 1;
    if (event.ctrlKey) mask |= 2;
    if (event.metaKey) mask |= 4;
    if (event.shiftKey) mask |= 8;
    return mask;
}

/**
 * Whether a key event carries one printable character that should be inserted as text.
 *
 * A single-character `key` is text; shift alone only changes its case, but any of ctrl/meta/alt turns
 * the press into a shortcut (`Ctrl+C`, `Cmd+V`) that must not also drop a literal character into the
 * page. Multi-character keys (`Enter`, `ArrowLeft`) are never text.
 *
 * Pure, unit-tested, and embedded into the app by source; its body references nothing outside itself.
 */
export function isPrintableKey(key: unknown, modifiers: number): boolean {
    if (typeof key !== 'string' || key.length !== 1) return false;
    if ((modifiers & 7) !== 0) return false;
    return true;
}

/**
 * The Windows virtual-key code for a DOM `KeyboardEvent.code`, or 0 when it is unknown.
 *
 * `code` names the physical key (layout-independent), so it is the reliable source for the
 * `windowsVirtualKeyCode` CDP's `Input.dispatchKeyEvent` expects. Letters, digits, the function keys
 * and the control keys a page reacts to are covered; anything else is sent as 0, which CDP treats as
 * "no code" rather than refusing the event.
 *
 * Pure, unit-tested, and embedded into the app by source; its body references nothing outside itself.
 */
export function keyCodeFor(code: unknown): number {
    if (typeof code !== 'string' || code === '') return 0;
    const named: Record<string, number> = {
        Enter: 13,
        NumpadEnter: 13,
        Tab: 9,
        Backspace: 8,
        Space: 32,
        Escape: 27,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34,
        Insert: 45,
        Delete: 46,
        ShiftLeft: 16,
        ShiftRight: 16,
        ControlLeft: 17,
        ControlRight: 17,
        AltLeft: 18,
        AltRight: 18,
        MetaLeft: 91,
        MetaRight: 91,
        ContextMenu: 93,
        CapsLock: 20,
        ArrowUp: 38,
        ArrowDown: 40,
        ArrowLeft: 37,
        ArrowRight: 39,
    };
    if (code in named) return named[code] ?? 0;
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
    if (/^Digit[0-9]$/.test(code)) return 48 + (code.charCodeAt(5) - 48);
    if (/^F([1-9]|1[0-2])$/.test(code)) return 111 + Number(code.slice(1));
    return 0;
}

/**
 * Builds the CDP mouse command for one pointer event over the live page, or `null` when it must not
 * fire.
 *
 * The point is the viewport coordinate `mapCanvasPointToPage` already returned (or `null` for the
 * letterbox or before a frame arrives); a `null` point, a control mode that is off, and a synthesized
 * `click`/`dblclick` event all build nothing. `mousedown`/`mouseup`/`mousemove` map to the pressed,
 * released and moved CDP types with `clickCount` only on the press and release, and `wheel` maps to a
 * `mouseWheel` carrying the deltas. The command is page-scoped by the app's `cdpSend`, which adds the
 * attached session id.
 *
 * Embedded into the app by source; it calls the sibling serializers above, which are in scope there.
 */
export function mapPointerEventToCdp(
    event: {
        type: unknown;
        button?: unknown;
        buttons?: unknown;
        detail?: unknown;
        deltaX?: unknown;
        deltaY?: unknown;
    },
    point: { viewportX: number; viewportY: number } | null,
    driving: boolean
): CdpCommand | null {
    if (!driving || !point) return null;
    const type = event.type;
    if (type === 'wheel') {
        return {
            method: 'Input.dispatchMouseEvent',
            params: {
                type: 'mouseWheel',
                x: point.viewportX,
                y: point.viewportY,
                deltaX: wheelDelta(event, 'deltaX'),
                deltaY: wheelDelta(event, 'deltaY'),
            },
        };
    }
    const cdpType =
        type === 'mousedown'
            ? 'mousePressed'
            : type === 'mouseup'
              ? 'mouseReleased'
              : type === 'mousemove'
                ? 'mouseMoved'
                : null;
    if (cdpType === null) return null;
    const params: Record<string, unknown> = {
        type: cdpType,
        x: point.viewportX,
        y: point.viewportY,
        button: mapMouseButton(event.button),
        buttons: mouseButtonsBitmask(event.buttons),
    };
    if (cdpType === 'mousePressed' || cdpType === 'mouseReleased') {
        params.clickCount = inferClickCount(event.detail);
    }
    return { method: 'Input.dispatchMouseEvent', params };
}

/**
 * Builds the CDP key command for a `keydown` or `keyup`, or `null` when it must not fire.
 *
 * The dispatch carries the `key` and `code` as the DOM received them, the `windowsVirtualKeyCode` for
 * `code`, and the modifier bitmask; the browser fills in `text` for itself only on a `char` event,
 * which this never sends, so a printable keydown does not insert twice.
 *
 * Embedded into the app by source; it calls the sibling serializers above, which are in scope there.
 */
export function mapKeyEventToCdp(
    event: {
        type: unknown;
        key?: unknown;
        code?: unknown;
        altKey?: unknown;
        ctrlKey?: unknown;
        metaKey?: unknown;
        shiftKey?: unknown;
    },
    driving: boolean
): CdpCommand | null {
    if (!driving) return null;
    const type = event.type === 'keydown' ? 'keyDown' : event.type === 'keyup' ? 'keyUp' : null;
    if (type === null) return null;
    return {
        method: 'Input.dispatchKeyEvent',
        params: {
            type,
            key: typeof event.key === 'string' ? event.key : '',
            code: typeof event.code === 'string' ? event.code : '',
            windowsVirtualKeyCode: keyCodeFor(event.code),
            modifiers: modifiersBitmask(event),
        },
    };
}

/**
 * Builds an `Input.insertText` command for a printable `keydown`, or `null` when it is not text entry.
 *
 * Puppeteer/Playwright insert composing text this way because it is more reliable than encoding it on
 * a key event. Only a single-character key with no ctrl/meta/alt qualifies; shift is allowed so an
 * upper-case letter reaches the page as itself.
 *
 * Embedded into the app by source; it calls the sibling serializers above, which are in scope there.
 */
export function mapCharToInsertText(
    event: {
        type: unknown;
        key?: unknown;
        altKey?: unknown;
        ctrlKey?: unknown;
        metaKey?: unknown;
        shiftKey?: unknown;
    },
    driving: boolean
): CdpCommand | null {
    if (!driving || event.type !== 'keydown') return null;
    const modifiers = modifiersBitmask(event);
    if (!isPrintableKey(event.key, modifiers)) return null;
    return { method: 'Input.insertText', params: { text: event.key } };
}

/**
 * The app: one static document, inline CSS and JS only, no subresources and no data of its own.
 *
 * The only values interpolated are the compile-time constants above and the source text of the
 * helpers, so the logic the browser runs is the logic the unit tests ran. Nothing derived from a
 * session, a page or a credential is ever interpolated, and page-derived strings reach the DOM
 * through `textContent` alone.
 *
 * The document's own CSP allows `wss:` generally rather than one host: the app is a single static
 * public resource that cannot know a deployment's CDP host, so the origin allowlist lives in the
 * resource's `_meta.ui.csp.connectDomains`, which the host enforces. Everything else is denied
 * here — no scripts, styles, frames, fonts or network images at all.
 */
export const SESSION_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src wss:; base-uri 'none'; form-action 'none'">
<title>Live browser session</title>
<style>
:root{color-scheme:light dark;--bg:#f4f4f5;--fg:#18181b;--dim:#52525b;--line:#d4d4d8}
@media (prefers-color-scheme: dark){:root{--bg:#111113;--fg:#f4f4f5;--dim:#a1a1aa;--line:#3f3f46}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
.stage{position:relative;width:100%;--ar:1.6;aspect-ratio:var(--ar);max-height:100dvh;max-width:calc(100dvh * var(--ar));margin:0 auto;overflow:hidden;background:#000;border-radius:8px}
canvas{position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:contain}
.veil{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;text-align:center;background:var(--bg);border:1px solid var(--line);border-radius:8px}
.spin{width:22px;height:22px;border:2px solid var(--line);border-top-color:var(--fg);border-radius:50%;animation:s .8s linear infinite}
[hidden]{display:none}
@keyframes s{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.spin{animation-duration:2.4s}}
h1{margin:0;font-size:14px;font-weight:600;max-width:44ch}
p{margin:0;color:var(--dim);max-width:52ch;overflow-wrap:anywhere}
p:empty{display:none}
.badge{position:absolute;left:8px;bottom:8px;padding:3px 8px;border-radius:999px;background:rgba(0,0,0,.62);color:#fafafa;font-size:11px;font-weight:600}
.ctl{position:absolute;right:8px;top:8px;display:flex;align-items:center;gap:6px}
.mode{padding:3px 8px;border-radius:999px;background:rgba(0,0,0,.62);color:#fafafa;font-size:11px;font-weight:600}
#control,#expand,#attach{padding:4px 10px;border-radius:999px;border:0;background:var(--fg);color:var(--bg);font:600 11px/1.4 system-ui,sans-serif;cursor:pointer}
#expand{background:rgba(0,0,0,.62);color:#fafafa}
#control[aria-pressed="true"]{background:#2563eb;color:#fff}
.stage.driving{box-shadow:inset 0 0 0 2px #2563eb}
.stage.driving canvas{cursor:crosshair}
</style>
</head>
<body>
<div class="stage" id="stage">
<canvas id="screen" tabindex="0" aria-label="Live view of the browser session"></canvas>
<div class="ctl" id="ctl" hidden><span class="mode" id="mode">Watching (read-only)</span><button id="attach" type="button" hidden>Choose local file</button><button id="expand" type="button">Full screen</button><button id="control" type="button" aria-pressed="false">Take control</button></div>
<input id="local-file" type="file" hidden>
<div class="badge" id="badge" hidden></div>
<div class="veil" id="veil" role="status" aria-live="polite">
<div class="spin" id="spin"></div>
<h1 id="head">Waiting for a browser session</h1>
<p id="note"></p>
</div>
</div>
<script>
(function(){
'use strict';
var READY_MESSAGE = ${JSON.stringify(SESSION_VIEWER_READY_MESSAGE_TYPE)};
var LIVE_VIEW_TOOL = ${JSON.stringify(SESSION_VIEWER_LIVE_VIEW_TOOL)};
var IDLE_AFTER_MS = ${SESSION_VIEWER_IDLE_AFTER_MS};
var APP_INFO = { name: 'browser-session-viewer', version: ${JSON.stringify(SERVER_VERSION)} };
var UI_PROTOCOL_VERSIONS = ['2026-01-26', '2025-11-25', '2025-06-18'];
var CALL_TIMEOUT_MS = 15000;
// How long a pushed session is waited for, then when to ask again while the server has none yet.
var PUSH_GRACE_MS = 400;
var ASK_RETRY_MS = [800, 2000, 5000];

var validateCdpUrl = ${validateCdpUrl};
var scrubCredentials = ${scrubCredentials};
var readSessionIdFromToolResult = ${readSessionIdFromToolResult};
	var readLiveView = ${readLiveView};
	var readControlLease = ${readControlLease};
var readToolErrorText = ${readToolErrorText};
var parseSocketMessage = ${parseSocketMessage};
	var readCdpReply = ${readCdpReply};
	var readFileChooserTarget = ${readFileChooserTarget};
var readScreencastFrame = ${readScreencastFrame};
var pickPageTargetId = ${pickPageTargetId};
var readAttachedSessionId = ${readAttachedSessionId};
var readBridgeResponse = ${readBridgeResponse};
var readToolResultNotification = ${readToolResultNotification};
var readTeardownRequest = ${readTeardownRequest};
var mapCanvasPointToPage = ${mapCanvasPointToPage};
var resolveViewerPhase = ${resolveViewerPhase};
var describeViewerPhase = ${describeViewerPhase};
var mapMouseButton = ${mapMouseButton};
var mouseButtonsBitmask = ${mouseButtonsBitmask};
var inferClickCount = ${inferClickCount};
var modifiersBitmask = ${modifiersBitmask};
var isPrintableKey = ${isPrintableKey};
var keyCodeFor = ${keyCodeFor};
var wheelDelta = ${wheelDelta};
var mapPointerEventToCdp = ${mapPointerEventToCdp};
var mapKeyEventToCdp = ${mapKeyEventToCdp};
var mapCharToInsertText = ${mapCharToInsertText};

var stage = document.getElementById('stage');
var canvas = document.getElementById('screen');
var context = canvas.getContext('2d');
var badge = document.getElementById('badge');
var veil = document.getElementById('veil');
var spin = document.getElementById('spin');
var head = document.getElementById('head');
var note = document.getElementById('note');
var ctl = document.getElementById('ctl');
var modeLabel = document.getElementById('mode');
var control = document.getElementById('control');
var expand = document.getElementById('expand');
var attachFile = document.getElementById('attach');
var localFile = document.getElementById('local-file');

var phase = 'awaiting-session';
var detail = '';
var painted = 0;
var lastFrameAt = null;
var lastMetadata = null;
var expiresAt = null;
var sessionId = null;
var cdpHost = null;
var cdpSessionId = null;
var socket = null;
var stopped = false;

function render(){
  var shown = resolveViewerPhase({ phase: phase, lastFrameAt: lastFrameAt, now: Date.now(), expiresAt: expiresAt, idleAfterMs: IDLE_AFTER_MS });
  var words = describeViewerPhase(shown);
  // Once a frame is on the canvas, a live or idle stream is a badge over it, not a panel that
  // hides it. Every other phase covers the canvas, so a stale frame is never mistaken for live.
  if (painted > 0 && (shown === 'painting' || shown === 'idle')) {
    veil.hidden = true;
    badge.hidden = false;
    badge.textContent = words.headline;
    return;
  }
  badge.hidden = true;
  veil.hidden = false;
  spin.hidden = !words.busy;
  head.textContent = words.headline;
  note.textContent = detail || words.detail;
}

function setPhase(next, why){
  phase = next;
  detail = scrubCredentials(why);
  render();
}

// --- host bridge: JSON-RPC over postMessage to the parent, nothing else ---

var nextBridgeId = 1;
var bridgePending = {};

function bridgeSend(method, params){
  var id = nextBridgeId++;
  window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*');
  return new Promise(function(resolve, reject){
    bridgePending[id] = { resolve: resolve, reject: reject };
    setTimeout(function(){
      if (bridgePending[id]) { delete bridgePending[id]; reject(new Error(method + ' got no answer from the host')); }
    }, CALL_TIMEOUT_MS);
  });
}

function bridgeNotify(method, params){
  window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params || {} }, '*');
}

window.addEventListener('message', function(event){
  if (event.source === window) return;
  var response = readBridgeResponse(event.data);
  if (response) {
    var entry = bridgePending[response.id];
    if (!entry) return;
    delete bridgePending[response.id];
    if (response.error) entry.reject(new Error(scrubCredentials(JSON.stringify(response.error))));
    else entry.resolve(response.result);
    return;
  }
  var pushed = readToolResultNotification(event.data);
  if (pushed) { onToolResult(pushed); return; }
  var teardown = readTeardownRequest(event.data);
  if (teardown) {
    stop();
    window.parent.postMessage({ jsonrpc: '2.0', id: teardown.id, result: {} }, '*');
  }
});

function initialize(index){
  if (index >= UI_PROTOCOL_VERSIONS.length) return Promise.reject(new Error('the host accepted no app protocol version'));
  return bridgeSend('ui/initialize', {
    protocolVersion: UI_PROTOCOL_VERSIONS[index],
    appCapabilities: {},
    appInfo: APP_INFO
  }).catch(function(){ return initialize(index + 1); });
}

// The host takes no tool call until the initialized notification lands, so everything waits on this.
var ready = initialize(0).then(function(){
  bridgeNotify('ui/notifications/initialized');
  if (window.parent !== window) window.parent.postMessage({ type: READY_MESSAGE }, '*');
}, function(error){
  setPhase('handshake-failed', error.message);
  throw error;
});

// The one tool-result push is never replayed, so a handshake that finished after it must ask.
ready.then(function(){
  setTimeout(function(){ if (!sessionId && !asking) start(null); }, PUSH_GRACE_MS);
}, function(){});

// --- the session: ask for a live view, then paint it ---

function onToolResult(params){
  if (sessionId) return;
  var id = readSessionIdFromToolResult(params);
  if (!id) return;
  sessionId = id;
  if (asking) return;
  ready.then(function(){ start(id); }, function(){});
}

// A call in flight, so the push and the grace timer cannot both start one; and how many asks so far.
var asking = false;
var asks = 0;

function start(id){
  asking = true;
  setPhase('connecting');
  var args = id ? { session_id: id } : {};
  return bridgeSend('tools/call', { name: LIVE_VIEW_TOOL, arguments: args }).then(function(result){
    var failure = readToolErrorText(result);
    if (failure) {
      // No session named and none live yet: the creating call may still be running. Ask again.
      var retryIn = id ? null : ASK_RETRY_MS[asks++];
      if (retryIn === undefined || retryIn === null) {
        setPhase(id ? 'live-view-failed' : 'awaiting-session', failure);
        asking = false;
        return;
      }
      asking = false;
      setPhase('awaiting-session', failure);
      setTimeout(function(){ if (!sessionId && !asking) start(null); }, retryIn);
      return;
    }
    var live = readLiveView(result);
    if (!live) { setPhase('live-view-failed', 'The live view tool returned no connection details.'); return; }
    // Known either way now, so a late push cannot open a second connection over this one.
    if (!sessionId) sessionId = live.sessionId;
    // The URL can drive the browser. It is validated here and never shown, logged or stored in the DOM.
    var target = validateCdpUrl(live.cdpUrl, cdpHost);
    if (!target) { setPhase('live-view-failed', 'The live view address was refused before anything was opened.'); return; }
    cdpHost = target.host;
    expiresAt = live.expiresAt;
    if (live.width > 0 && live.height > 0) stage.style.setProperty('--ar', String(live.width / live.height));
    // Now that the page's shape is known, ask the host for a box that shape fits in.
    shapeKnown = true;
    askForRoom();
    connect(target.url);
  }, function(error){
    setPhase('live-view-failed', error.message);
  });
}

function connect(url){
  var opened;
  try {
    opened = new WebSocket(url);
  } catch (error) {
    setPhase('live-view-failed', 'This app sandbox refused the browser connection.');
    return;
  }
  socket = opened;
  var everOpen = false;
  opened.onopen = function(){ everOpen = true; attach(); };
  opened.onmessage = function(event){ receive(event.data); };
  // A socket the host's sandbox refuses is closed before it ever reaches the network, and fires only
  // an error: no close event follows, so without this the app would sit on the spinner for good.
  opened.onerror = function(){
    if (stopped || opened !== socket || everOpen) return;
    setPhase('live-view-failed', 'The browser connection could not be opened. The chat host may not permit it.');
  };
  // Only a connection that was up can have dropped; one that never opened is reported above.
  opened.onclose = function(){ if (!stopped && opened === socket && everOpen) setPhase('closed'); };
}

var nextCdpId = 1;
var cdpPending = {};

function cdpSend(method, params){
  if (!socket || socket.readyState !== 1) return Promise.reject(new Error(method + ' had no open connection'));
  var id = nextCdpId++;
  var frame = { id: id, method: method, params: params || {} };
  if (cdpSessionId) frame.sessionId = cdpSessionId;
  socket.send(JSON.stringify(frame));
  return new Promise(function(resolve, reject){
    cdpPending[id] = { resolve: resolve, reject: reject };
    setTimeout(function(){
      if (cdpPending[id]) { delete cdpPending[id]; reject(new Error(method + ' timed out')); }
    }, CALL_TIMEOUT_MS);
  });
}

function receive(raw){
  var message = parseSocketMessage(raw);
  if (!message) return;
  var reply = readCdpReply(message);
  if (reply) {
    var entry = cdpPending[reply.id];
    if (!entry) return;
    delete cdpPending[reply.id];
    if (reply.errorMessage) entry.reject(new Error(reply.errorMessage));
    else entry.resolve(reply.result);
    return;
  }
  var frame = readScreencastFrame(message);
  if (frame) paint(frame);
  var chooser = readFileChooserTarget(message);
  if (chooser) offerLocalFile(chooser);
}

function attach(){
  cdpSend('Target.getTargets').then(function(result){
    var targetId = pickPageTargetId(result);
    if (!targetId) throw new Error('the session has no page to show');
    return cdpSend('Target.attachToTarget', { targetId: targetId, flatten: true });
  }).then(function(result){
    var attached = readAttachedSessionId(result);
    if (!attached) throw new Error('the browser did not attach to the page');
    cdpSessionId = attached;
    ctl.hidden = false;
    setPhase('awaiting-first-frame');
    return Promise.all([
      cdpSend('Page.enable'),
      cdpSend('DOM.enable'),
      cdpSend('Runtime.enable'),
      cdpSend('Page.setInterceptFileChooserDialog', { enabled: true }).catch(function(){})
    ]);
  }).then(function(){
    return cdpSend('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  }).catch(function(error){
    if (!stopped) setPhase('live-view-failed', error.message);
  });
}

function paint(frame){
  // Ack first and never behind the decode: the browser sends no further frame until this lands.
  cdpSend('Page.screencastFrameAck', { sessionId: frame.ackSessionId }).catch(function(){});
  lastMetadata = frame.metadata;
  stage.style.setProperty('--ar', String(frame.metadata.deviceWidth / frame.metadata.deviceHeight));
  var image = new Image();
  image.onload = function(){
    if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
    }
    context.drawImage(image, 0, 0);
    painted++;
    lastFrameAt = Date.now();
    if (phase === 'awaiting-first-frame' || phase === 'idle') phase = 'painting';
    detail = '';
    render();
  };
  // A frame that will not decode changes nothing: the next repaint replaces it.
  image.onerror = function(){};
  image.src = frame.dataUrl;
}

function stop(){
  stopped = true;
  releaseControl();
  if (!socket) return;
  var closing = socket;
  socket = null;
  try {
    if (closing.readyState === 1 && cdpSessionId) {
      closing.send(JSON.stringify({ id: nextCdpId++, method: 'Page.stopScreencast', params: {}, sessionId: cdpSessionId }));
    }
  } catch (error) {}
  try { closing.close(); } catch (error) {}
}

window.addEventListener('pagehide', stop);

// Take control: off by default, so a click on the canvas reaches nothing on the wire. Toggled on,
// every pointer and key event the canvas receives is mapped to a CDP Input command and sent over the
// attached session. The drive-capable CDP address never enters this path: only the mapped point and
// the DOM event itself do, and no input-related text is ever derived from a CDP reply.
var driving = false;
var controlToken = null;
var controlRenewTimer = null;
var CONTROL_RENEW_MS = 20000;

function setDriving(on){
  driving = on;
  control.setAttribute('aria-pressed', on ? 'true' : 'false');
  control.textContent = on ? 'Hand back' : 'Take control';
  modeLabel.textContent = on ? 'You are driving this browser' : 'Watching (read-only)';
  if (on) { stage.classList.add('driving'); canvas.focus(); }
  else { stage.classList.remove('driving'); }
}

function controlCall(action, token){
  if (!sessionId || sessionId === 'resolved-by-server') return Promise.reject(new Error('The viewer has no session id.'));
  var args = { session_id: sessionId, action: action };
  if (token) args.control_token = token;
  return bridgeSend('tools/call', { name: LIVE_VIEW_TOOL, arguments: args }).then(function(result){
    var failure = readToolErrorText(result);
    if (failure) throw new Error(failure);
    return result;
  });
}

function scheduleControlRenewal(){
  if (controlRenewTimer) clearTimeout(controlRenewTimer);
  if (!controlToken || stopped) return;
  controlRenewTimer = setTimeout(function(){
    var token = controlToken;
    controlCall('renew', token).then(function(result){
      var lease = readControlLease(result);
      if (!lease || lease.token !== token) throw new Error('The control lease was not renewed.');
      scheduleControlRenewal();
    }).catch(function(error){
      controlToken = null;
      setDriving(false);
      modeLabel.textContent = scrubCredentials(error.message) || 'Human control ended';
    });
  }, CONTROL_RENEW_MS);
}

function acquireControl(){
  control.disabled = true;
  modeLabel.textContent = 'Claiming control…';
  controlCall('acquire').then(function(result){
    var lease = readControlLease(result);
    if (!lease) throw new Error('The server returned no control lease.');
    controlToken = lease.token;
    setDriving(true);
    scheduleControlRenewal();
  }).catch(function(error){
    setDriving(false);
    modeLabel.textContent = scrubCredentials(error.message) || 'Could not take control';
  }).then(function(){ control.disabled = false; });
}

function releaseControl(){
  var token = controlToken;
  controlToken = null;
  if (controlRenewTimer) clearTimeout(controlRenewTimer);
  controlRenewTimer = null;
  setDriving(false);
  if (!token || !sessionId || sessionId === 'resolved-by-server') return Promise.resolve();
  return controlCall('release', token).catch(function(){ /* The bounded lease expires by itself. */ });
}

control.addEventListener('click', function(){
  if (driving) releaseControl();
  else acquireControl();
});

// Local files stay on the user plane: the person picks one in this trusted viewer, then the bytes
// travel over the session-scoped CDP socket straight into a File object in the remote page. No path,
// byte or base64 string crosses an MCP tool call or enters model context.
var pendingFileChooser = null;
var MAX_LOCAL_FILE_BYTES = 5 * 1024 * 1024;

function offerLocalFile(target){
  if (!driving) {
    modeLabel.textContent = 'Take control, then click the page’s file button again';
    return;
  }
  pendingFileChooser = target;
  attachFile.hidden = false;
  modeLabel.textContent = 'File requested — choose it locally';
}

attachFile.addEventListener('click', function(){
  if (!driving || !pendingFileChooser) return;
  localFile.value = '';
  localFile.click();
});

function fileAsBase64(file){
  return new Promise(function(resolve, reject){
    var reader = new FileReader();
    reader.onload = function(){
      var value = typeof reader.result === 'string' ? reader.result : '';
      var comma = value.indexOf(',');
      if (comma < 0) reject(new Error('The selected file could not be read.'));
      else resolve(value.slice(comma + 1));
    };
    reader.onerror = function(){ reject(new Error('The selected file could not be read.')); };
    reader.readAsDataURL(file);
  });
}

function pageOrigin(){
  return cdpSend('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }).then(function(result){
    var value = result && result.result && result.result.value;
    return typeof value === 'string' && value.length <= 100 ? value : 'the current page';
  }, function(){ return 'the current page'; });
}

function installLocalFile(target, file, base64){
  return cdpSend('DOM.resolveNode', { backendNodeId: target.backendNodeId }).then(function(result){
    var objectId = result && result.object && result.object.objectId;
    if (typeof objectId !== 'string') throw new Error('The page file input is no longer available.');
    return cdpSend('Runtime.callFunctionOn', {
      objectId: objectId,
      functionDeclaration: "function(data,name,type){var raw=atob(data),bytes=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);var f=new File([bytes],name,{type:type||'application/octet-stream'}),d=new DataTransfer();d.items.add(f);this.files=d.files;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true}",
      arguments: [{ value: base64 }, { value: file.name }, { value: file.type }],
      returnByValue: true,
      awaitPromise: false
    });
  });
}

localFile.addEventListener('change', function(){
  var file = localFile.files && localFile.files[0];
  var target = pendingFileChooser;
  if (!file || !target) return;
  if (file.size > MAX_LOCAL_FILE_BYTES) {
    modeLabel.textContent = 'File is over the 5 MB secure viewer limit';
    return;
  }
  attachFile.disabled = true;
  pageOrigin().then(function(origin){
    var size = Math.max(1, Math.round(file.size / 1024));
    if (!window.confirm('Attach “' + file.name + '” (' + size + ' KB) to ' + origin + '? The site may upload it immediately.')) {
      throw new Error('File selection cancelled.');
    }
    return fileAsBase64(file);
  }).then(function(base64){
    return installLocalFile(target, file, base64);
  }).then(function(){
    pendingFileChooser = null;
    attachFile.hidden = true;
    modeLabel.textContent = 'File attached — you are driving';
  }).catch(function(error){
    modeLabel.textContent = scrubCredentials(error.message) || 'File was not attached';
  }).then(function(){ attachFile.disabled = false; localFile.value = ''; });
});

// A host sizes an inline view for a card, not for a browser: a 16:9 page arrives as a letterboxed
// strip a few pixels tall. These are the two levers the apps protocol gives a view — ask for the
// height the content needs, and offer the person the host's own full-screen mode.
var displayMode = 'inline';

// Set once the live view has answered, which is the first moment this view knows it has something to
// size. A layout that settles before then — which a frame sharing the page's process does — would
// otherwise ask the host for room against a placeholder ratio, and ask again for the real one.
var shapeKnown = false;

function askForRoom(){
  if (!shapeKnown) return;
  var width = Math.round(document.documentElement.clientWidth || stage.clientWidth || 0);
  if (width < 1) return;
  var ratio = parseFloat(stage.style.getPropertyValue('--ar')) || 1.6;
  bridgeNotify('ui/notifications/size-changed', { width: width, height: Math.round(width / ratio) });
}

function setDisplayMode(mode){
  displayMode = mode;
  expand.textContent = mode === 'fullscreen' ? 'Exit full screen' : 'Full screen';
  askForRoom();
}

expand.addEventListener('click', function(){
  var wanted = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
  expand.disabled = true;
  bridgeSend('ui/request-display-mode', { mode: wanted }).then(function(result){
    expand.disabled = false;
    var got = result && result.mode;
    // The host answers with the mode it actually set. One that ignores the ask has no full-screen
    // to offer, so the control goes away rather than sit there doing nothing a second time.
    if (got !== wanted) { expand.hidden = true; return; }
    setDisplayMode(got);
  }, function(){ expand.disabled = false; expand.hidden = true; });
});

window.addEventListener('resize', askForRoom);

function sendCdpCommand(cmd){
  if (!cmd) return;
  cdpSend(cmd.method, cmd.params).catch(function(){});
}

function forwardPointer(event){
  if (!driving) return;
  var cmd = mapPointerEventToCdp(event, pointFromCanvasEvent(event), driving);
  if (!cmd) return;
  event.preventDefault();
  sendCdpCommand(cmd);
}

function forwardKey(event){
  if (!driving) return;
  var keyCmd = mapKeyEventToCdp(event, driving);
  if (!keyCmd) return;
  event.preventDefault();
  sendCdpCommand(keyCmd);
  sendCdpCommand(mapCharToInsertText(event, driving));
}

// mousedown/mouseup carry the click count, so a real click and a double-click are one press and one
// release each; the synthesized click/dblclick events are ignored to avoid firing a click twice.
canvas.addEventListener('mousedown', forwardPointer);
canvas.addEventListener('mouseup', forwardPointer);
canvas.addEventListener('mousemove', forwardPointer);
canvas.addEventListener('wheel', forwardPointer);
canvas.addEventListener('keydown', forwardKey);
canvas.addEventListener('keyup', forwardKey);
canvas.addEventListener('contextmenu', function(event){ if (driving) event.preventDefault(); });

function pointFromCanvasEvent(event){
  if (!lastMetadata) return null;
  var box = canvas.getBoundingClientRect();
  return mapCanvasPointToPage(
    { x: event.clientX - box.left, y: event.clientY - box.top },
    { width: box.width, height: box.height },
    lastMetadata
  );
}

// An idle page sends nothing at all, so the phase has to be re-read from the clock, not from events.
setInterval(render, 400);
render();

window.steelSessionViewer = { start: start, stop: stop, pointFromCanvasEvent: pointFromCanvasEvent };
})();
</script>
</body>
</html>
`;
