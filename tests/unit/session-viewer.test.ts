// ABOUTME: Unit tests for the MCP-App session viewer: the CDP URL and frame validators, the
// ABOUTME: coordinate mapping, the input->CDP serializers, the phase reducer, and the HTML string.
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
    describeViewerPhase,
    inferClickCount,
    isPrintableKey,
    keyCodeFor,
    mapCanvasPointToPage,
    mapCharToInsertText,
    mapKeyEventToCdp,
    mapMouseButton,
    mapPointerEventToCdp,
    modifiersBitmask,
    mouseButtonsBitmask,
    parseSocketMessage,
    pickPageTargetId,
    readAttachedSessionId,
    readBridgeResponse,
    readCdpReply,
    readControlLease,
    readFileChooserTarget,
    readLiveView,
    readScreencastFrame,
    readSessionIdFromToolResult,
    readTeardownRequest,
    readToolErrorText,
    readToolResultNotification,
    resolveViewerPhase,
    SESSION_VIEWER_HTML,
    SESSION_VIEWER_IDLE_AFTER_MS,
    SESSION_VIEWER_LIVE_VIEW_TOOL,
    SESSION_VIEWER_MIME_TYPE,
    SESSION_VIEWER_READY_MESSAGE_TYPE,
    SESSION_VIEWER_URI,
    scrubCredentials,
    type ViewerPhase,
    validateCdpUrl,
    wheelDelta,
} from '../../src/core/apps/session-viewer.js';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uIjoiMSJ9.Zm9vYmFyc2lnbmF0dXJl';
const SESSION_ID = 'sess_MHKz9dQ1TjqLmA7vXpR2bw';
const CDP_URL = `wss://connect.steel.dev?sessionId=8f0b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d&token=${TOKEN}`;

const metadata = {
    offsetTop: 0,
    pageScaleFactor: 1,
    deviceWidth: 1280,
    deviceHeight: 800,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
};

describe('validateCdpUrl', () => {
    it('accepts a Steel CDP socket URL and reports its host for pinning', () => {
        expect(validateCdpUrl(CDP_URL, null)).toEqual({ url: CDP_URL, host: 'connect.steel.dev' });
    });

    it('returns the URL byte for byte, so the token and query the server issued survive', () => {
        expect(validateCdpUrl(CDP_URL, null)?.url).toBe(CDP_URL);
    });

    it('refuses any scheme but wss', () => {
        expect(validateCdpUrl('ws://connect.steel.dev?token=x', null)).toBe(null);
        expect(validateCdpUrl('https://connect.steel.dev?token=x', null)).toBe(null);
        expect(validateCdpUrl('javascript:alert(1)', null)).toBe(null);
        expect(validateCdpUrl('data:text/html,<script></script>', null)).toBe(null);
    });

    it('refuses userinfo that makes a foreign host read as the expected one', () => {
        expect(validateCdpUrl('wss://connect.steel.dev@evil.example/?token=x', null)).toBe(null);
        expect(validateCdpUrl('wss://user:pw@connect.steel.dev/?token=x', null)).toBe(null);
    });

    it('refuses a host that differs from the one already pinned, port included', () => {
        expect(validateCdpUrl(CDP_URL, 'connect.steel.dev')).not.toBe(null);
        expect(validateCdpUrl(CDP_URL, 'evil.example')).toBe(null);
        expect(validateCdpUrl('wss://connect.steel.dev:9222/?token=x', 'connect.steel.dev')).toBe(null);
    });

    it('refuses an unparseable, relative or non-string value', () => {
        expect(validateCdpUrl('connect.steel.dev?token=x', null)).toBe(null);
        expect(validateCdpUrl('', null)).toBe(null);
        expect(validateCdpUrl(undefined, null)).toBe(null);
        expect(validateCdpUrl({ toString: () => CDP_URL }, null)).toBe(null);
    });
});

describe('scrubCredentials', () => {
    it('strips the query off any socket URL that reaches a message', () => {
        expect(scrubCredentials(`failed to open ${CDP_URL}`)).toBe('failed to open wss://connect.steel.dev');
        expect(scrubCredentials(`ws://host/path?token=${TOKEN} refused`)).toBe('ws://host/path refused');
    });

    it('redacts a bare credential parameter and a bare JWT', () => {
        expect(scrubCredentials(`token=${TOKEN}`)).toBe('token=<redacted>');
        expect(scrubCredentials(`apiKey=ste-123456789 rejected`)).toBe('apiKey=<redacted> rejected');
        expect(scrubCredentials(`bearer ${TOKEN} expired`)).toBe('bearer <redacted> expired');
    });

    it('leaves ordinary text alone and returns empty for a non-string', () => {
        expect(scrubCredentials('Page.enable timed out')).toBe('Page.enable timed out');
        expect(scrubCredentials(undefined)).toBe('');
        expect(scrubCredentials(null)).toBe('');
        expect(scrubCredentials({ message: 'x' })).toBe('');
    });

    it('truncates so a hostile message cannot flood the panel', () => {
        expect(scrubCredentials('x'.repeat(500)).length).toBeLessThanOrEqual(200);
    });
});

describe('readSessionIdFromToolResult', () => {
    it('reads session_id out of the pushed tool result', () => {
        expect(readSessionIdFromToolResult({ structuredContent: { session_id: SESSION_ID } })).toBe(SESSION_ID);
    });

    it('ignores a result for some other tool, or one with no structured content', () => {
        expect(readSessionIdFromToolResult({ structuredContent: { released: true } })).toBe(null);
        expect(readSessionIdFromToolResult({ content: [{ type: 'text', text: SESSION_ID }] })).toBe(null);
        expect(readSessionIdFromToolResult(null)).toBe(null);
        expect(readSessionIdFromToolResult('sess_x')).toBe(null);
    });

    it('refuses a session_id that is not a plain handle', () => {
        expect(readSessionIdFromToolResult({ structuredContent: { session_id: 'sess_a b' } })).toBe(null);
        expect(readSessionIdFromToolResult({ structuredContent: { session_id: 'x' } })).toBe(null);
        expect(readSessionIdFromToolResult({ structuredContent: { session_id: 'a'.repeat(200) } })).toBe(null);
        expect(readSessionIdFromToolResult({ structuredContent: { session_id: 42 } })).toBe(null);
    });
});

describe('readLiveView', () => {
    const result = {
        structuredContent: {
            session_id: SESSION_ID,
            cdp_url: CDP_URL,
            viewport: { width: 1280, height: 800 },
            expires_at: '2026-07-31T12:00:00.000Z',
        },
    };

    it('reads the connection details the live-view tool returns', () => {
        expect(readLiveView(result)).toEqual({
            sessionId: SESSION_ID,
            cdpUrl: CDP_URL,
            width: 1280,
            height: 800,
            expiresAt: Date.parse('2026-07-31T12:00:00.000Z'),
        });
    });

    it('accepts an expiry given as epoch milliseconds or seconds', () => {
        const at = Date.parse('2026-07-31T12:00:00.000Z');
        expect(
            readLiveView({ structuredContent: { session_id: SESSION_ID, cdp_url: CDP_URL, expires_at: at } })?.expiresAt
        ).toBe(at);
        expect(
            readLiveView({ structuredContent: { session_id: SESSION_ID, cdp_url: CDP_URL, expires_at: at / 1000 } })
                ?.expiresAt
        ).toBe(at);
    });

    it('reports an unknown viewport and an unknown expiry rather than inventing one', () => {
        const bare = readLiveView({ structuredContent: { session_id: SESSION_ID, cdp_url: CDP_URL } });
        expect(bare).toEqual({ sessionId: SESSION_ID, cdpUrl: CDP_URL, width: 0, height: 0, expiresAt: null });
        expect(
            readLiveView({ structuredContent: { session_id: SESSION_ID, cdp_url: CDP_URL, expires_at: 'soon' } })
                ?.expiresAt
        ).toBe(null);
        expect(
            readLiveView({
                structuredContent: { session_id: SESSION_ID, cdp_url: CDP_URL, viewport: { width: -5, height: 0 } },
            })?.width
        ).toBe(0);
    });

    it('returns nothing for a failed call or a result with no cdp_url', () => {
        expect(readLiveView({ ...result, isError: true })).toBe(null);
        expect(readLiveView({ structuredContent: { viewport: { width: 1280, height: 800 } } })).toBe(null);
        expect(readLiveView({ structuredContent: { cdp_url: '' } })).toBe(null);
        expect(readLiveView(undefined)).toBe(null);
    });
});

describe('viewer control and file-selection messages', () => {
    it('accepts only a complete human control lease', () => {
        const result = {
            structuredContent: {
                control: { state: 'human', token: 'ctl_abc', lease_expires_at: '2026-08-08T12:00:00.000Z' },
            },
        };
        expect(readControlLease(result)).toEqual({
            token: 'ctl_abc',
            leaseExpiresAt: Date.parse('2026-08-08T12:00:00.000Z'),
        });
        expect(readControlLease({ structuredContent: { control: { state: 'agent' } } })).toBe(null);
        expect(readControlLease({ structuredContent: { control: { state: 'human', token: 'ctl_x' } } })).toBe(null);
    });

    it('accepts only Chrome file chooser events with a backend node id', () => {
        expect(
            readFileChooserTarget({
                method: 'Page.fileChooserOpened',
                params: { backendNodeId: 42, mode: 'selectSingle' },
            })
        ).toEqual({ backendNodeId: 42 });
        expect(readFileChooserTarget({ method: 'Page.fileChooserOpened', params: { backendNodeId: -1 } })).toBe(null);
        expect(readFileChooserTarget({ method: 'Page.loadEventFired', params: { backendNodeId: 42 } })).toBe(null);
    });
});

describe('readToolErrorText', () => {
    it('reads the message off a tool result that reports failure', () => {
        expect(
            readToolErrorText({
                isError: true,
                content: [{ type: 'text', text: 'No live browser session for that id.' }],
            })
        ).toBe('No live browser session for that id.');
    });

    it('returns nothing for a successful result or one with no text', () => {
        expect(readToolErrorText({ content: [{ type: 'text', text: 'fine' }] })).toBe(null);
        expect(readToolErrorText({ isError: true, content: [] })).toBe(null);
        expect(readToolErrorText({ isError: true })).toBe(null);
        expect(readToolErrorText(null)).toBe(null);
    });
});

describe('parseSocketMessage', () => {
    it('parses a JSON object off the socket', () => {
        expect(parseSocketMessage('{"id":1,"result":{}}')).toEqual({ id: 1, result: {} });
    });

    it('refuses anything that is not a JSON object, and anything absurdly large', () => {
        expect(parseSocketMessage('not json')).toBe(null);
        expect(parseSocketMessage('[1,2]')).toBe(null);
        expect(parseSocketMessage('"text"')).toBe(null);
        expect(parseSocketMessage('null')).toBe(null);
        expect(parseSocketMessage(new ArrayBuffer(8))).toBe(null);
        expect(parseSocketMessage(`{"data":"${'a'.repeat(2_100_000)}"}`)).toBe(null);
    });
});

describe('readCdpReply', () => {
    it('reads a successful reply', () => {
        expect(readCdpReply({ id: 7, result: { sessionId: 'ABC' } })).toEqual({
            id: 7,
            result: { sessionId: 'ABC' },
            errorMessage: null,
        });
    });

    it('reads an error reply as a message', () => {
        expect(readCdpReply({ id: 7, error: { code: -32000, message: 'Not allowed' } })).toEqual({
            id: 7,
            result: null,
            errorMessage: 'Not allowed',
        });
        expect(readCdpReply({ id: 7, error: {} })?.errorMessage).toBe('the browser refused the command');
    });

    it('is not fooled by an event or a reply with no id', () => {
        expect(readCdpReply({ method: 'Page.screencastFrame', params: {} })).toBe(null);
        expect(readCdpReply({ result: {} })).toBe(null);
        expect(readCdpReply({ id: '7', result: {} })).toBe(null);
        expect(readCdpReply(null)).toBe(null);
    });
});

describe('readScreencastFrame', () => {
    const frame = {
        method: 'Page.screencastFrame',
        params: { data: 'AAAA', sessionId: 1, metadata },
    };

    it('reads the frame, the ack session and a data URL built from the base64 payload', () => {
        expect(readScreencastFrame(frame)).toEqual({
            ackSessionId: 1,
            dataUrl: 'data:image/jpeg;base64,AAAA',
            metadata,
        });
    });

    it('refuses a payload that is not plain base64, so nothing else can enter the data URL', () => {
        for (const data of ['AA,A', 'AAA', 'A A=', 'text/html;base64,x', '<svg/>', '', 'AA=A']) {
            expect(readScreencastFrame({ ...frame, params: { ...frame.params, data } })).toBe(null);
        }
    });

    it('refuses a frame whose ack session is not the int32 the ack command takes', () => {
        // Chrome types this as an integer both on the event and on Page.screencastFrameAck, and
        // refuses the ack outright when it is anything else, which stalls the stream after one frame.
        for (const sessionId of ['A1B2C3', '1', '', 1.5, -1, 2 ** 31, Number.NaN, null, undefined]) {
            expect(readScreencastFrame({ ...frame, params: { ...frame.params, sessionId } })).toBe(null);
        }
        expect(readScreencastFrame({ ...frame, params: { ...frame.params, sessionId: 0 } })?.ackSessionId).toBe(0);
    });

    it('refuses metadata that would break the coordinate mapping', () => {
        expect(readScreencastFrame({ ...frame, params: { ...frame.params, metadata: undefined } })).toBe(null);
        for (const bad of [
            { deviceWidth: 0 },
            { deviceHeight: -1 },
            { pageScaleFactor: 0 },
            { offsetTop: Number.NaN },
            { scrollOffsetY: Number.POSITIVE_INFINITY },
            { scrollOffsetX: '0' },
        ]) {
            expect(
                readScreencastFrame({ ...frame, params: { ...frame.params, metadata: { ...metadata, ...bad } } })
            ).toBe(null);
        }
    });

    it('ignores any other CDP event', () => {
        expect(readScreencastFrame({ method: 'Page.loadEventFired', params: {} })).toBe(null);
        expect(readScreencastFrame({ id: 1, result: {} })).toBe(null);
        expect(readScreencastFrame(null)).toBe(null);
    });
});

describe('pickPageTargetId and readAttachedSessionId', () => {
    it('picks the first real page target', () => {
        expect(
            pickPageTargetId({
                targetInfos: [
                    { type: 'browser', targetId: 'B1' },
                    { type: 'page', targetId: 'P1', url: 'https://example.com/' },
                    { type: 'page', targetId: 'P2', url: 'https://example.org/' },
                ],
            })
        ).toBe('P1');
    });

    it('skips devtools and extension pages', () => {
        expect(
            pickPageTargetId({
                targetInfos: [
                    { type: 'page', targetId: 'D1', url: 'devtools://devtools/bundled/x.html' },
                    { type: 'page', targetId: 'E1', url: 'chrome-extension://abc/panel.html' },
                    { type: 'page', targetId: 'P9', url: 'about:blank' },
                ],
            })
        ).toBe('P9');
    });

    it('returns nothing when there is no page to show', () => {
        expect(pickPageTargetId({ targetInfos: [{ type: 'service_worker', targetId: 'S1' }] })).toBe(null);
        expect(pickPageTargetId({ targetInfos: [] })).toBe(null);
        expect(pickPageTargetId({})).toBe(null);
        expect(pickPageTargetId(null)).toBe(null);
    });

    it('reads the flat session id off an attach reply', () => {
        expect(readAttachedSessionId({ sessionId: 'A1B2C3' })).toBe('A1B2C3');
        expect(readAttachedSessionId({ sessionId: '' })).toBe(null);
        expect(readAttachedSessionId({})).toBe(null);
        expect(readAttachedSessionId(null)).toBe(null);
    });
});

describe('readBridgeResponse, readToolResultNotification and readTeardownRequest', () => {
    it('reads a JSON-RPC response to one of our own requests', () => {
        expect(readBridgeResponse({ jsonrpc: '2.0', id: 3, result: { hostInfo: {} } })).toEqual({
            id: 3,
            result: { hostInfo: {} },
            error: null,
        });
        expect(readBridgeResponse({ jsonrpc: '2.0', id: 3, error: { code: -32601 } })?.error).toEqual({ code: -32601 });
    });

    it('ignores our own outgoing request echoed back, and anything not JSON-RPC', () => {
        expect(readBridgeResponse({ jsonrpc: '2.0', id: 3, method: 'ui/initialize', params: {} })).toBe(null);
        expect(readBridgeResponse({ id: 3, result: {} })).toBe(null);
        expect(readBridgeResponse({ jsonrpc: '2.0', result: {} })).toBe(null);
        expect(readBridgeResponse('hello')).toBe(null);
    });

    it('reads the params off a tool-result notification only', () => {
        const params = { structuredContent: { session_id: SESSION_ID } };
        expect(readToolResultNotification({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params })).toEqual(
            params
        );
        expect(readToolResultNotification({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params })).toBe(
            null
        );
        expect(
            readToolResultNotification({ jsonrpc: '2.0', id: 1, method: 'ui/notifications/tool-result', params })
        ).toBe(null);
        expect(readToolResultNotification({ jsonrpc: '2.0', method: 'ui/notifications/tool-result' })).toBe(null);
    });

    it('reads the id off a teardown request so it can be answered', () => {
        expect(readTeardownRequest({ jsonrpc: '2.0', id: 9, method: 'ui/resource-teardown', params: {} })).toEqual({
            id: 9,
        });
        expect(readTeardownRequest({ jsonrpc: '2.0', method: 'ui/resource-teardown' })).toBe(null);
        expect(readTeardownRequest({ jsonrpc: '2.0', id: 9, method: 'ui/initialize' })).toBe(null);
    });
});

describe('mapCanvasPointToPage', () => {
    const canvas = { width: 1280, height: 800 };

    it('maps one to one when the canvas is rendered at the captured size', () => {
        expect(mapCanvasPointToPage({ x: 100, y: 200 }, canvas, metadata)).toEqual({
            viewportX: 100,
            viewportY: 200,
            pageX: 100,
            pageY: 200,
        });
    });

    it('undoes the render scale when the canvas is smaller than the capture', () => {
        expect(mapCanvasPointToPage({ x: 100, y: 200 }, { width: 640, height: 400 }, metadata)).toEqual({
            viewportX: 200,
            viewportY: 400,
            pageX: 200,
            pageY: 400,
        });
    });

    it('accounts for the letterbox a contained canvas leaves, and refuses a point inside it', () => {
        // 800x800 box around a 1280x800 capture: scale 0.625, 150px of letterbox top and bottom.
        const box = { width: 800, height: 800 };
        expect(mapCanvasPointToPage({ x: 400, y: 150 }, box, metadata)).toEqual({
            viewportX: 640,
            viewportY: 0,
            pageX: 640,
            pageY: 0,
        });
        expect(mapCanvasPointToPage({ x: 400, y: 100 }, box, metadata)).toBe(null);
        expect(mapCanvasPointToPage({ x: 400, y: 651 }, box, metadata)).toBe(null);
    });

    it('divides out the page scale factor and subtracts the top offset', () => {
        expect(mapCanvasPointToPage({ x: 640, y: 400 }, canvas, { ...metadata, pageScaleFactor: 2 })).toEqual({
            viewportX: 320,
            viewportY: 200,
            pageX: 320,
            pageY: 200,
        });
        expect(mapCanvasPointToPage({ x: 100, y: 100 }, canvas, { ...metadata, offsetTop: 60 })).toEqual({
            viewportX: 100,
            viewportY: 40,
            pageX: 100,
            pageY: 40,
        });
    });

    it('adds the scroll offset to the page coordinates and leaves the viewport pair alone', () => {
        expect(
            mapCanvasPointToPage({ x: 100, y: 200 }, canvas, { ...metadata, scrollOffsetX: 30, scrollOffsetY: 500 })
        ).toEqual({ viewportX: 100, viewportY: 200, pageX: 130, pageY: 700 });
    });

    it('refuses a point or a geometry it cannot map', () => {
        expect(mapCanvasPointToPage({ x: Number.NaN, y: 0 }, canvas, metadata)).toBe(null);
        expect(mapCanvasPointToPage({ x: 0, y: 0 }, { width: 0, height: 800 }, metadata)).toBe(null);
        expect(mapCanvasPointToPage({ x: 0, y: 0 }, canvas, { ...metadata, deviceWidth: 0 })).toBe(null);
        expect(mapCanvasPointToPage({ x: -1, y: 0 }, canvas, metadata)).toBe(null);
        expect(mapCanvasPointToPage({ x: 1281, y: 0 }, canvas, metadata)).toBe(null);
    });
});

describe('resolveViewerPhase', () => {
    const now = 1_800_000_000_000;
    const base = { now, expiresAt: null, idleAfterMs: SESSION_VIEWER_IDLE_AFTER_MS, lastFrameAt: null };

    it('keeps a painting stream painting while frames are recent', () => {
        expect(resolveViewerPhase({ ...base, phase: 'painting', lastFrameAt: now - 200 })).toBe('painting');
    });

    it('calls a stream with no recent frame idle, not broken', () => {
        expect(resolveViewerPhase({ ...base, phase: 'painting', lastFrameAt: now - 9_000 })).toBe('idle');
        expect(resolveViewerPhase({ ...base, phase: 'idle', lastFrameAt: now - 9_000 })).toBe('idle');
    });

    it('leaves idle again as soon as a frame arrives', () => {
        expect(resolveViewerPhase({ ...base, phase: 'idle', lastFrameAt: now })).toBe('painting');
    });

    it('never claims to be painting before the first frame', () => {
        expect(resolveViewerPhase({ ...base, phase: 'painting', lastFrameAt: null })).toBe('awaiting-first-frame');
    });

    it('reports an elapsed expiry over any live phase, since that is the one actionable failure', () => {
        const expired = { ...base, expiresAt: now - 1 };
        for (const phase of ['connecting', 'awaiting-first-frame', 'painting', 'idle', 'closed'] as ViewerPhase[]) {
            expect(resolveViewerPhase({ ...expired, phase, lastFrameAt: now - 1 })).toBe('expired');
        }
    });

    it('does not blame the expiry for a failure that happened before the connection', () => {
        const expired = { ...base, expiresAt: now - 1 };
        for (const phase of ['handshake-failed', 'awaiting-session', 'live-view-failed'] as ViewerPhase[]) {
            expect(resolveViewerPhase({ ...expired, phase })).toBe(phase);
        }
    });

    it('passes every other phase straight through', () => {
        for (const phase of ['connecting', 'awaiting-first-frame', 'closed', 'expired'] as ViewerPhase[]) {
            expect(resolveViewerPhase({ ...base, phase })).toBe(phase);
        }
    });
});

describe('describeViewerPhase', () => {
    const phases: ViewerPhase[] = [
        'handshake-failed',
        'awaiting-session',
        'live-view-failed',
        'connecting',
        'awaiting-first-frame',
        'painting',
        'idle',
        'closed',
        'expired',
    ];

    it('gives every phase its own headline', () => {
        const headlines = phases.map(phase => describeViewerPhase(phase).headline);
        expect(new Set(headlines).size).toBe(phases.length);
        for (const headline of headlines) expect(headline.length).toBeGreaterThan(0);
    });

    it('spins only while something is actually in flight', () => {
        expect(describeViewerPhase('connecting').busy).toBe(true);
        expect(describeViewerPhase('awaiting-first-frame').busy).toBe(true);
        expect(describeViewerPhase('awaiting-session').busy).toBe(true);
        for (const phase of [
            'painting',
            'idle',
            'closed',
            'expired',
            'handshake-failed',
            'live-view-failed',
        ] as const) {
            expect(describeViewerPhase(phase).busy).toBe(false);
        }
    });

    it('explains an idle stream as a still page rather than a fault', () => {
        const idle = describeViewerPhase('idle');
        expect(idle.detail).toMatch(/repaint/i);
        expect(`${idle.headline} ${idle.detail}`).not.toMatch(/error|fail|broken|problem/i);
    });

    it('tells the user an expired live view needs a new session', () => {
        expect(describeViewerPhase('expired').detail).toMatch(/new session/i);
    });

    it('falls back to a waiting state for a phase it does not know', () => {
        expect(describeViewerPhase('nonsense' as ViewerPhase).busy).toBe(true);
    });
});

/** A DOM pointer/mouse event shape, with the fields the serializer reads, and test defaults. */
function pointerEvent(
    overrides: Partial<{
        type: string;
        button: number;
        buttons: number;
        detail: number;
        deltaX: number;
        deltaY: number;
        deltaMode: number;
    }> = {}
) {
    return { type: 'mousedown', button: 0, buttons: 1, detail: 1, deltaX: 0, deltaY: 0, deltaMode: 0, ...overrides };
}

describe('the input->CDP serializers', () => {
    describe('mapMouseButton', () => {
        it('maps the three real buttons and treats everything else as none', () => {
            expect(mapMouseButton(0)).toBe('left');
            expect(mapMouseButton(1)).toBe('middle');
            expect(mapMouseButton(2)).toBe('right');
            expect(mapMouseButton(3)).toBe('none');
            expect(mapMouseButton(4)).toBe('none');
            expect(mapMouseButton(undefined)).toBe('none');
            expect(mapMouseButton('x')).toBe('none');
        });
    });

    describe('mouseButtonsBitmask', () => {
        it('passes the DOM buttons bitmask through, clamped to the five bits Chrome defines', () => {
            expect(mouseButtonsBitmask(0)).toBe(0);
            expect(mouseButtonsBitmask(1)).toBe(1); // left
            expect(mouseButtonsBitmask(2)).toBe(2); // right
            expect(mouseButtonsBitmask(4)).toBe(4); // middle
            expect(mouseButtonsBitmask(3)).toBe(3); // left + right
            expect(mouseButtonsBitmask(16)).toBe(16); // forward
            expect(mouseButtonsBitmask(31)).toBe(31);
            expect(mouseButtonsBitmask(64)).toBe(0); // beyond the five button bits
        });

        it('returns no mask for a value that is not a finite non-negative number', () => {
            expect(mouseButtonsBitmask(-1)).toBe(0);
            expect(mouseButtonsBitmask(Number.NaN)).toBe(0);
            expect(mouseButtonsBitmask(1.5)).toBe(1);
            expect(mouseButtonsBitmask('1')).toBe(0);
            expect(mouseButtonsBitmask(undefined)).toBe(0);
        });
    });

    describe('inferClickCount', () => {
        it('uses the DOM detail (2 for a double click) and falls back to a single click', () => {
            expect(inferClickCount(1)).toBe(1);
            expect(inferClickCount(2)).toBe(2);
            expect(inferClickCount(3)).toBe(3);
            expect(inferClickCount(undefined)).toBe(1);
            expect(inferClickCount(0)).toBe(1);
            expect(inferClickCount(1.5)).toBe(1);
            expect(inferClickCount(-2)).toBe(1);
        });
    });

    describe('modifiersBitmask', () => {
        it('sets the CDP bit for each held modifier', () => {
            expect(modifiersBitmask({})).toBe(0);
            expect(modifiersBitmask({ altKey: true })).toBe(1);
            expect(modifiersBitmask({ ctrlKey: true })).toBe(2);
            expect(modifiersBitmask({ metaKey: true })).toBe(4);
            expect(modifiersBitmask({ shiftKey: true })).toBe(8);
            expect(modifiersBitmask({ ctrlKey: true, shiftKey: true })).toBe(10);
            expect(modifiersBitmask({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
        });
    });

    describe('keyCodeFor', () => {
        it('maps letters, digits and the common control keys to their Windows virtual-key code', () => {
            expect(keyCodeFor('KeyA')).toBe(65);
            expect(keyCodeFor('KeyZ')).toBe(90);
            expect(keyCodeFor('Digit0')).toBe(48);
            expect(keyCodeFor('Digit9')).toBe(57);
            expect(keyCodeFor('Enter')).toBe(13);
            expect(keyCodeFor('NumpadEnter')).toBe(13);
            expect(keyCodeFor('Tab')).toBe(9);
            expect(keyCodeFor('Space')).toBe(32);
            expect(keyCodeFor('Backspace')).toBe(8);
            expect(keyCodeFor('Escape')).toBe(27);
            expect(keyCodeFor('ArrowLeft')).toBe(37);
            expect(keyCodeFor('ArrowUp')).toBe(38);
            expect(keyCodeFor('ArrowRight')).toBe(39);
            expect(keyCodeFor('ArrowDown')).toBe(40);
            expect(keyCodeFor('ShiftLeft')).toBe(16);
            expect(keyCodeFor('ControlRight')).toBe(17);
            expect(keyCodeFor('MetaLeft')).toBe(91);
            expect(keyCodeFor('F1')).toBe(112);
            expect(keyCodeFor('F12')).toBe(123);
        });

        it('returns 0 for a key it does not know', () => {
            expect(keyCodeFor('')).toBe(0);
            expect(keyCodeFor('Key?')).toBe(0);
            expect(keyCodeFor('Semicolon')).toBe(0);
            expect(keyCodeFor(undefined)).toBe(0);
            expect(keyCodeFor(13)).toBe(0);
        });
    });

    describe('isPrintableKey', () => {
        it('treats a single character as text unless a non-shift modifier is held', () => {
            expect(isPrintableKey('a', 0)).toBe(true);
            expect(isPrintableKey('A', 8)).toBe(true); // shift alone is still text entry
            expect(isPrintableKey('a', 2)).toBe(false); // ctrl+a is a shortcut
            expect(isPrintableKey('a', 4)).toBe(false); // meta+a
            expect(isPrintableKey('a', 1)).toBe(false); // alt+a
            expect(isPrintableKey('Enter', 0)).toBe(false);
            expect(isPrintableKey('', 0)).toBe(false);
            expect(isPrintableKey('ab', 0)).toBe(false);
            expect(isPrintableKey(undefined, 0)).toBe(false);
        });
    });

    describe('mapPointerEventToCdp', () => {
        const point = { viewportX: 100, viewportY: 200 };

        it('builds a mousePressed dispatch with the mapped button, buttons and click count', () => {
            expect(mapPointerEventToCdp(pointerEvent(), point, true)).toEqual({
                method: 'Input.dispatchMouseEvent',
                params: { type: 'mousePressed', x: 100, y: 200, button: 'left', buttons: 1, clickCount: 1 },
            });
        });

        it('builds a mouseReleased dispatch for mouseup', () => {
            const cmd = mapPointerEventToCdp(
                pointerEvent({ type: 'mouseup', button: 2, buttons: 0, detail: 1 }),
                point,
                true
            );
            expect(cmd?.params).toMatchObject({ type: 'mouseReleased', button: 'right', buttons: 0, clickCount: 1 });
        });

        it('builds a mouseMoved dispatch for mousemove with no click count', () => {
            const cmd = mapPointerEventToCdp(pointerEvent({ type: 'mousemove', buttons: 0 }), point, true);
            expect(cmd?.params).toMatchObject({ type: 'mouseMoved', buttons: 0 });
            expect(cmd?.params).not.toHaveProperty('clickCount');
        });

        it('builds a mouseWheel dispatch carrying the deltas for wheel', () => {
            const cmd = mapPointerEventToCdp(pointerEvent({ type: 'wheel', deltaX: 3, deltaY: 24 }), point, true);
            expect(cmd?.params).toMatchObject({ type: 'mouseWheel', x: 100, y: 200, deltaX: 3, deltaY: 24 });
            expect(cmd?.params).not.toHaveProperty('clickCount');
        });

        it('scales wheel deltas from lines and pages into CSS pixels', () => {
            // deltaMode 0 = pixels (passthrough), 1 = lines (x16), 2 = pages (x320).
            const lines = mapPointerEventToCdp(
                pointerEvent({ type: 'wheel', deltaX: 0, deltaY: 3, deltaMode: 1 }),
                point,
                true
            );
            expect(lines?.params).toMatchObject({ deltaX: 0, deltaY: 48 });
            const pages = mapPointerEventToCdp(
                pointerEvent({ type: 'wheel', deltaX: 1, deltaY: 2, deltaMode: 2 }),
                point,
                true
            );
            expect(pages?.params).toMatchObject({ deltaX: 320, deltaY: 640 });
        });

        it('raises the click count for a double click', () => {
            const cmd = mapPointerEventToCdp(pointerEvent({ detail: 2 }), point, true);
            expect(cmd?.params.clickCount).toBe(2);
        });

        it('builds nothing when the point is null (the letterbox, or no frame yet)', () => {
            expect(mapPointerEventToCdp(pointerEvent(), null, true)).toBe(null);
        });

        it('builds nothing when control is off, and ignores derived click/dblclick events always', () => {
            expect(mapPointerEventToCdp(pointerEvent(), point, false)).toBe(null);
            expect(mapPointerEventToCdp(pointerEvent({ type: 'click' }), point, true)).toBe(null);
            expect(mapPointerEventToCdp(pointerEvent({ type: 'dblclick', detail: 2 }), point, true)).toBe(null);
        });
    });

    describe('mapKeyEventToCdp and mapCharToInsertText', () => {
        const keyEvent = (
            overrides: Partial<{
                type: string;
                key: string;
                code: string;
                shiftKey: boolean;
                ctrlKey: boolean;
                altKey: boolean;
                metaKey: boolean;
            }> = {}
        ) => ({
            type: 'keydown',
            key: 'a',
            code: 'KeyA',
            shiftKey: false,
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            ...overrides,
        });

        it('builds a keyDown dispatch carrying the key, code, virtual-key code and modifiers', () => {
            expect(mapKeyEventToCdp(keyEvent(), true)).toEqual({
                method: 'Input.dispatchKeyEvent',
                params: { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 },
            });
        });

        it('builds a keyUp dispatch and folds the held modifiers into the bitmask', () => {
            const cmd = mapKeyEventToCdp(keyEvent({ type: 'keyup', key: 'A', shiftKey: true }), true);
            expect(cmd?.params).toMatchObject({ type: 'keyUp', key: 'A', windowsVirtualKeyCode: 65, modifiers: 8 });
        });

        it('maps Enter, Tab and an arrow to their virtual-key codes', () => {
            expect(mapKeyEventToCdp(keyEvent({ key: 'Enter', code: 'Enter' }), true)?.params).toMatchObject({
                key: 'Enter',
                windowsVirtualKeyCode: 13,
            });
            expect(mapKeyEventToCdp(keyEvent({ key: 'Tab', code: 'Tab' }), true)?.params).toMatchObject({
                windowsVirtualKeyCode: 9,
            });
            expect(mapKeyEventToCdp(keyEvent({ key: 'ArrowLeft', code: 'ArrowLeft' }), true)?.params).toMatchObject({
                windowsVirtualKeyCode: 37,
            });
        });

        it('inserts text for a printable keydown with no shortcut modifier', () => {
            expect(mapCharToInsertText(keyEvent({ key: 'a' }), true)).toEqual({
                method: 'Input.insertText',
                params: { text: 'a' },
            });
            expect(mapCharToInsertText(keyEvent({ key: 'A', shiftKey: true }), true)).toEqual({
                method: 'Input.insertText',
                params: { text: 'A' },
            });
        });

        it('does not insert text on keyup, for a control key, or when a shortcut modifier is held', () => {
            expect(mapCharToInsertText(keyEvent({ type: 'keyup' }), true)).toBe(null);
            expect(mapCharToInsertText(keyEvent({ key: 'Enter', code: 'Enter' }), true)).toBe(null);
            expect(mapCharToInsertText(keyEvent({ ctrlKey: true }), true)).toBe(null);
            expect(mapCharToInsertText(keyEvent({ metaKey: true }), true)).toBe(null);
            expect(mapCharToInsertText(keyEvent({ altKey: true }), true)).toBe(null);
        });

        it('builds nothing at all when control is off', () => {
            expect(mapKeyEventToCdp(keyEvent(), false)).toBe(null);
            expect(mapCharToInsertText(keyEvent(), false)).toBe(null);
        });
    });
});

describe('SESSION_VIEWER_HTML', () => {
    const inlineScript = SESSION_VIEWER_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    const inlineStyle = SESSION_VIEWER_HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

    it('is a complete standalone document served as an MCP app', () => {
        expect(SESSION_VIEWER_HTML.startsWith('<!doctype html>')).toBe(true);
        expect(SESSION_VIEWER_HTML).toContain('</html>');
        expect(SESSION_VIEWER_URI).toBe('ui://browser/session-viewer');
        expect(SESSION_VIEWER_MIME_TYPE).toBe('text/html;profile=mcp-app');
    });

    it('loads no external subresource', () => {
        expect(SESSION_VIEWER_HTML).not.toMatch(/<script[^>]+\bsrc\b/i);
        expect(SESSION_VIEWER_HTML).not.toMatch(/\s(?:src|href|srcset|poster|integrity)\s*=/i);
        expect(SESSION_VIEWER_HTML).not.toMatch(/<link\b|<img\b|<iframe\b/i);
        expect(inlineStyle).not.toBe('');
        expect(inlineStyle).not.toMatch(/@import|url\(/i);
    });

    it('references no http origin at all, so nothing but the CDP socket leaves the page', () => {
        expect(SESSION_VIEWER_HTML).not.toMatch(/https?:\/\//i);
    });

    it('carries a CSP that allows only inline code, data-URL frames and a wss socket', () => {
        expect(SESSION_VIEWER_HTML).toContain(
            `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src wss:; base-uri 'none'; form-action 'none'">`
        );
    });

    it('bakes in no session data and no credential of any kind', () => {
        expect(SESSION_VIEWER_HTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(SESSION_VIEWER_HTML).not.toContain('sess_');
        expect(SESSION_VIEWER_HTML).not.toMatch(/\btoken=[^<'"]/);
        expect(SESSION_VIEWER_HTML).not.toMatch(/\bey[A-Za-z0-9_-]{6,}\./);
    });

    it('does the host handshake before it calls a tool, and announces readiness', () => {
        const initialize = inlineScript.indexOf("'ui/initialize'");
        const initialized = inlineScript.indexOf("'ui/notifications/initialized'");
        const call = inlineScript.indexOf("'tools/call'");
        expect(initialize).toBeGreaterThan(-1);
        expect(initialized).toBeGreaterThan(initialize);
        expect(call).toBeGreaterThan(initialized);
        expect(inlineScript).toContain('2026-01-26');
        expect(inlineScript).toContain('2025-11-25');
        expect(inlineScript).toContain('2025-06-18');
        expect(inlineScript).toContain(SESSION_VIEWER_READY_MESSAGE_TYPE);
    });

    it('asks the live-view tool for the connection details by name', () => {
        expect(inlineScript).toContain(SESSION_VIEWER_LIVE_VIEW_TOOL);
        expect(SESSION_VIEWER_LIVE_VIEW_TOOL).toBe('browser_session_live_view');
    });

    it('drives the screencast attach flow and acks every frame', () => {
        for (const command of [
            'Target.getTargets',
            'Target.attachToTarget',
            'Page.enable',
            'Page.startScreencast',
            'Page.screencastFrameAck',
            'Page.stopScreencast',
        ]) {
            expect(inlineScript).toContain(command);
        }
        expect(inlineScript).toContain('flatten: true');
        // The ack has to leave before the frame is decoded or the stream stalls behind us.
        expect(inlineScript.indexOf('Page.screencastFrameAck')).toBeLessThan(inlineScript.indexOf('new Image()'));
    });

    it('tears the socket down when the host says the view is going away', () => {
        expect(inlineScript).toContain('ui/resource-teardown');
        expect(inlineScript).toContain("addEventListener('pagehide'");
    });

    it('paints into a canvas and never into markup', () => {
        expect(SESSION_VIEWER_HTML).toContain('<canvas');
        expect(inlineScript).toContain("getContext('2d')");
        expect(inlineScript).toContain('drawImage');
        expect(SESSION_VIEWER_HTML).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
        expect(SESSION_VIEWER_HTML).not.toMatch(/\beval\(|new Function/);
        expect(SESSION_VIEWER_HTML).toContain('.textContent');
    });

    it('forwards input only once take-control is on, and ships read-only as the default', () => {
        // The Input.* serializers are embedded, the canvas listens, and the host page is kept out of
        // the way with preventDefault — but driving starts false, so a click before take-control is
        // still a no-op on the wire (asserted end to end in the browser suite).
        expect(inlineScript).toContain('Input.dispatchMouseEvent');
        expect(inlineScript).toContain('Input.dispatchKeyEvent');
        expect(inlineScript).toContain('Input.insertText');
        expect(inlineScript).toContain("addEventListener('mousedown'");
        expect(inlineScript).toContain("addEventListener('keydown'");
        expect(inlineScript).toContain("addEventListener('wheel'");
        expect(inlineScript).toContain('preventDefault');
        expect(inlineScript).toMatch(/var driving = false/);
        expect(inlineScript).toContain('pointFromCanvasEvent');
        expect(inlineScript).toContain('mapCanvasPointToPage');
        expect(inlineScript).toContain('getBoundingClientRect');
    });

    it('adapts to the host theme and to the captured aspect ratio', () => {
        expect(inlineStyle).toContain('prefers-color-scheme: dark');
        expect(inlineStyle).toContain('aspect-ratio');
        expect(inlineScript).toContain("setProperty('--ar'");
    });

    it('ships the tested helpers verbatim rather than a second copy of the logic', () => {
        for (const helper of [
            validateCdpUrl,
            scrubCredentials,
            readSessionIdFromToolResult,
            readLiveView,
            readToolErrorText,
            parseSocketMessage,
            readCdpReply,
            readScreencastFrame,
            pickPageTargetId,
            readAttachedSessionId,
            readBridgeResponse,
            readToolResultNotification,
            readTeardownRequest,
            mapCanvasPointToPage,
            resolveViewerPhase,
            describeViewerPhase,
            mapMouseButton,
            mouseButtonsBitmask,
            inferClickCount,
            modifiersBitmask,
            isPrintableKey,
            keyCodeFor,
            wheelDelta,
            mapPointerEventToCdp,
            mapKeyEventToCdp,
            mapCharToInsertText,
        ]) {
            expect(SESSION_VIEWER_HTML).toContain(helper.toString());
        }
    });

    it('ships helpers that depend on nothing outside their own bodies', () => {
        // The app runs these outside this module with only browser globals in scope, so a reference
        // to an imported or module-level name would throw there instead of here.
        const isolate = <T>(helper: T): T => new Function(`return (${helper});`)() as T;
        expect(isolate(validateCdpUrl)(CDP_URL, null)).toEqual({ url: CDP_URL, host: 'connect.steel.dev' });
        expect(isolate(scrubCredentials)(`token=${TOKEN}`)).toBe('token=<redacted>');
        expect(isolate(readSessionIdFromToolResult)({ structuredContent: { session_id: SESSION_ID } })).toBe(
            SESSION_ID
        );
        expect(isolate(readLiveView)({ structuredContent: { session_id: SESSION_ID, cdp_url: CDP_URL } })?.cdpUrl).toBe(
            CDP_URL
        );
        expect(isolate(readToolErrorText)({ isError: true, content: [{ type: 'text', text: 'no' }] })).toBe('no');
        expect(isolate(parseSocketMessage)('{"id":1,"result":{}}')).toEqual({ id: 1, result: {} });
        expect(isolate(readCdpReply)({ id: 1, result: {} })?.id).toBe(1);
        expect(
            isolate(readControlLease)({
                structuredContent: {
                    control: { state: 'human', token: 'ctl_x', lease_expires_at: '2026-08-08T12:00:00Z' },
                },
            })?.token
        ).toBe('ctl_x');
        expect(
            isolate(readFileChooserTarget)({ method: 'Page.fileChooserOpened', params: { backendNodeId: 9 } })
                ?.backendNodeId
        ).toBe(9);
        expect(
            isolate(readScreencastFrame)({
                method: 'Page.screencastFrame',
                params: { data: 'AAAA', sessionId: 7, metadata },
            })?.ackSessionId
        ).toBe(7);
        expect(isolate(pickPageTargetId)({ targetInfos: [{ type: 'page', targetId: 'P1' }] })).toBe('P1');
        expect(isolate(readAttachedSessionId)({ sessionId: 'A1' })).toBe('A1');
        expect(isolate(readBridgeResponse)({ jsonrpc: '2.0', id: 1, result: {} })?.id).toBe(1);
        expect(
            isolate(readToolResultNotification)({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {} })
        ).toEqual({});
        expect(isolate(readTeardownRequest)({ jsonrpc: '2.0', id: 2, method: 'ui/resource-teardown' })).toEqual({
            id: 2,
        });
        expect(isolate(mapCanvasPointToPage)({ x: 0, y: 0 }, { width: 1280, height: 800 }, metadata)?.pageX).toBe(0);
        expect(
            isolate(resolveViewerPhase)({
                phase: 'painting',
                lastFrameAt: 1,
                now: 1,
                expiresAt: null,
                idleAfterMs: 1500,
            })
        ).toBe('painting');
        expect(isolate(describeViewerPhase)('idle').busy).toBe(false);
        // The input serializers that run standalone in the app: the primitives are self-contained, so
        // they run with nothing but browser globals in scope. The dispatch builders reference these
        // siblings by name and are exercised through the Node tests above, not through this isolate.
        expect(isolate(mapMouseButton)(0)).toBe('left');
        expect(isolate(wheelDelta)({ deltaY: 3, deltaMode: 1 }, 'deltaY')).toBe(48);
        expect(isolate(mapMouseButton)(2)).toBe('right');
        expect(isolate(mouseButtonsBitmask)(3)).toBe(3);
        expect(isolate(mouseButtonsBitmask)(64)).toBe(0);
        expect(isolate(inferClickCount)(2)).toBe(2);
        expect(isolate(inferClickCount)(undefined)).toBe(1);
        expect(isolate(modifiersBitmask)({ ctrlKey: true, shiftKey: true })).toBe(10);
        expect(isolate(isPrintableKey)('a', 0)).toBe(true);
        expect(isolate(isPrintableKey)('a', 2)).toBe(false);
        expect(isolate(keyCodeFor)('KeyA')).toBe(65);
        expect(isolate(keyCodeFor)('Enter')).toBe(13);
        expect(isolate(keyCodeFor)('Semicolon')).toBe(0);
    });

    it('ships an inline script that parses as JavaScript', () => {
        // Compiled, never run: the interpolated helper sources are the part that could break the
        // document, and a parse error would otherwise only surface inside a host's iframe.
        expect(inlineScript).not.toBe('');
        expect(() => new Script(inlineScript)).not.toThrow();
    });

    it('closes no tag early: no helper source can break out of the script element', () => {
        expect(inlineScript).not.toMatch(/<\/script|<!--/i);
    });

    it('stays small enough to ship on every resources/read', () => {
        // ~32.1KB as this test runner emits the helper sources; 34,341 bytes as `tsc` emits them
        // into dist, which is what actually ships, and 9,958 gzipped — measured 2026-08-04. The
        // growth over the read-only viewer is the take-control feature (mouse/keyboard/wheel
        // serializers and the virtual-key-code table a page needs to react to real keys) and the
        // display controls: a host sizes an inline view for a card, so the app asks for the height
        // its aspect ratio needs and offers the host's full-screen mode. The resource is static and
        // publicly cacheable, so a host pays it once rather than per call. This is still a ceiling:
        // a doubling means something was inlined that should not have been.
        expect(Buffer.byteLength(SESSION_VIEWER_HTML, 'utf8')).toBeLessThan(48_000);
    });
});
