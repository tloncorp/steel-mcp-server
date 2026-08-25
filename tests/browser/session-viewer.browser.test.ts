// ABOUTME: Runs the MCP-App session viewer in a real headless Chrome behind a strict fake host and a
// ABOUTME: fake CDP endpoint, so its bridge order, painting, phases and teardown are executed, not read.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_VIEWER_IDLE_AFTER_MS, SESSION_VIEWER_LIVE_VIEW_TOOL } from '../../src/core/apps/session-viewer.js';
import { type FakeCdpOptions, FakeCdpServer, findOpenssl, frameMetadata } from '../helpers/fake-cdp-server.js';
import { announceMissing, findChrome, HeadlessChrome, until } from '../helpers/headless-chrome.js';
import { type FakeHostOptions, FakeMcpAppHost, type HostedViewer } from '../helpers/mcp-app-host.js';

const chromePath = findChrome();
const openssl = findOpenssl();
const missing = [chromePath === null ? 'Google Chrome' : null, openssl === null ? 'openssl' : null].filter(
    (name): name is string => name !== null
);
const available = missing.length === 0;
announceMissing('the session viewer browser suite', missing);

const SESSION_ID = 'sess-7f3a91c2b4d5';
const MAGENTA: [number, number, number] = [255, 0, 255];
const CYAN: [number, number, number] = [0, 255, 255];
const JPEG_WIDTH = 64;
const JPEG_HEIGHT = 40;
// The one expensive hook owns a 90s launch, a 20s WebSocket handshake and four 20s CDP commands.
// Its bound is scoped here so a broken cleanup hook still fails at the ordinary 60s project limit.
const BROWSER_SETUP_TIMEOUT_MS = 220_000;

let chrome: HeadlessChrome | undefined;
let magentaJpeg: string;
let cyanJpeg: string;

/** Everything the running test opened, torn down newest first however the test ended. */
let openedByTest: Array<() => Promise<void>> = [];

beforeAll(async () => {
    if (!available) return;
    chrome = await HeadlessChrome.launch(chromePath!);
    magentaJpeg = await chrome.encodeJpeg('#ff00ff', JPEG_WIDTH, JPEG_HEIGHT);
    cyanJpeg = await chrome.encodeJpeg('#00ffff', JPEG_WIDTH, JPEG_HEIGHT);
}, BROWSER_SETUP_TIMEOUT_MS);

afterAll(async () => {
    // Guarded on the browser rather than on `available`, because a launch that threw leaves the
    // prerequisites present and the browser unset, and closing it then buries the real failure.
    if (chrome !== undefined) await chrome.close();
});

afterEach(async () => {
    // Taken before anything is awaited. Vitest does not cancel a hook it timed out, so one that
    // resumes later would otherwise still be holding the list and would tear down the resources of
    // whichever test is running by then, reporting the failure against the wrong test.
    const opened = openedByTest;
    openedByTest = [];
    while (opened.length > 0) await opened.pop()!();
});

async function startCdp(options: FakeCdpOptions = {}): Promise<FakeCdpServer> {
    const server = await FakeCdpServer.start(openssl!, options);
    openedByTest.push(() => server.stop());
    return server;
}

async function startHost(options: FakeHostOptions): Promise<FakeMcpAppHost> {
    const host = await FakeMcpAppHost.start(options);
    openedByTest.push(() => host.stop());
    return host;
}

/** The browser this run launched. A test only reaches it after `beforeAll` succeeded. */
function browser(): HeadlessChrome {
    if (chrome === undefined) throw new Error('The session viewer suite ran a test without a launched Chrome.');
    return chrome;
}

async function openViewer(host: FakeMcpAppHost): Promise<HostedViewer> {
    const viewer = await host.open(browser());
    openedByTest.push(() => viewer.page.close());
    return viewer;
}

/** JPEG colours come back through a lossy encoder, so a painted pixel is compared with a tolerance. */
function isColour(pixel: readonly number[], expected: readonly [number, number, number]): boolean {
    return expected.every((channel, index) => Math.abs((pixel[index] ?? -1) - channel) <= 24) && pixel[3] === 255;
}

interface Stage {
    cdp: FakeCdpServer;
    viewer: HostedViewer;
}

/**
 * The ordinary case: a host that hands out a working live view for a session it has pushed.
 *
 * Returns once the app has opened its socket, which is the last thing that happens without a frame.
 */
async function connected(
    overrides: { cdp?: FakeCdpOptions; host?: FakeHostOptions; expiresAt?: string | number } = {}
): Promise<Stage> {
    const cdp = await startCdp(overrides.cdp);
    const host = await startHost({
        liveView: {
            kind: 'ok',
            cdpUrl: cdp.url,
            viewport: { width: 1600, height: 1000 },
            expiresAt: overrides.expiresAt,
        },
        ...overrides.host,
    });
    const viewer = await openViewer(host);
    await viewer.pushToolResult({ session_id: SESSION_ID });
    await cdp.waitForConnection();
    return { cdp, viewer };
}

/** Drives the app all the way to a painted magenta frame and returns once the canvas shows it. */
async function painting(overrides: Parameters<typeof connected>[0] = {}): Promise<Stage> {
    const stage = await connected(overrides);
    await stage.cdp.waitFor('Page.startScreencast');
    stage.cdp.sendFrame(magentaJpeg);
    await until(
        'the first frame to reach the canvas',
        () => stage.viewer.canvas(),
        canvas => canvas.width === JPEG_WIDTH && isColour(canvas.centre, MAGENTA)
    );
    return stage;
}

describe.skipIf(!available)('the session viewer in a real browser', () => {
    describe('the host bridge', () => {
        it('handshakes then calls a tool, in that order and with nothing the host has to refuse', async () => {
            const { cdp, viewer } = await connected();
            const log = await viewer.log();

            expect(log.violations).toEqual([]);
            expect(log.messages.map(message => message.method)).toEqual([
                'ui/initialize',
                'ui/notifications/initialized',
                'tools/call',
                // Sent once the live view names the page's shape: the host sizes an inline view for
                // a card, and a browser needs the height its aspect ratio implies.
                'ui/notifications/size-changed',
            ]);
            expect(log.messages[0]!.params).toMatchObject({
                protocolVersion: '2026-01-26',
                appCapabilities: {},
                appInfo: { name: 'browser-session-viewer' },
            });
            expect(log.ready).toBe(true);
            expect(cdp.connectionCount).toBe(1);
            expect(viewer.page.appExceptions).toEqual([]);
        });

        it('holds a tool call that is ready early until the handshake has actually finished', async () => {
            // The host takes its time over ui/initialize, so the session arrives while the app is
            // still mid-handshake. Getting this wrong means a tools/call a real host would refuse.
            const cdp = await startCdp();
            const host = await startHost({
                initializeDelayMs: 750,
                liveView: { kind: 'ok', cdpUrl: cdp.url },
            });
            const viewer = await openViewer(host);
            await viewer.pushToolResult({ session_id: SESSION_ID });

            expect((await viewer.log()).initialized, 'the push must land before the handshake ends').toBe(false);
            await cdp.waitForConnection();

            const log = await viewer.log();
            expect(log.violations).toEqual([]);
            expect(log.messages.map(message => message.method)).toEqual([
                'ui/initialize',
                'ui/notifications/initialized',
                'tools/call',
                // Sent once the live view names the page's shape: the host sizes an inline view for
                // a card, and a browser needs the height its aspect ratio implies.
                'ui/notifications/size-changed',
            ]);
        });

        it('asks for the session itself when the host never pushes a tool result', async () => {
            // Claude renders the app while the creating call is still running and pushes the result
            // once, when that call completes. The spec has no replay and no way to ask again, so an
            // app whose handshake finishes after that instant is stuck for ever unless it asks.
            const cdp = await startCdp();
            const host = await startHost({ liveView: { kind: 'ok', cdpUrl: cdp.url } });
            const viewer = await openViewer(host);

            await cdp.waitForConnection();

            const log = await viewer.log();
            expect(log.violations).toEqual([]);
            expect(log.messages.map(message => message.method)).toEqual([
                'ui/initialize',
                'ui/notifications/initialized',
                'tools/call',
                // Sent once the live view names the page's shape: the host sizes an inline view for
                // a card, and a browser needs the height its aspect ratio implies.
                'ui/notifications/size-changed',
            ]);
            // No session to name, so it names none and lets the server pick the caller's own.
            expect(log.messages[2]!.params!.arguments).toEqual({});
        });

        it('asks the host for the height its aspect ratio needs, not the strip it is given', async () => {
            // Claude gives an inline view a short box. The app fits itself into it, so a 1280x720
            // page renders as a narrow letterboxed strip — measured at roughly 305x150 in a 780px
            // wide panel. Telling the host what the content needs is the only lever an app has.
            const { viewer } = await connected();

            const sizes = (await viewer.log()).messages.filter(
                message => message.method === 'ui/notifications/size-changed'
            );
            expect(sizes.length).toBeGreaterThan(0);
            const last = sizes[sizes.length - 1]!.params as { width: number; height: number };
            // 1600x1000 viewport from `connected`, so the height asked for tracks the width over 1.6.
            expect(last.height).toBeGreaterThan(last.width / 1.7);
            expect(last.height).toBeLessThan(last.width / 1.5);
        });

        it('offers full screen, and asks the host for it when a person clicks', async () => {
            const { viewer } = await painting();

            expect(await viewer.expandControl()).toMatchObject({ label: 'Full screen', hidden: false });
            await viewer.clickExpand();

            await until(
                'the app to show it is full screen',
                () => viewer.expandControl(),
                control => control.label !== 'Full screen'
            );
            const requests = (await viewer.log()).messages.filter(
                message => message.method === 'ui/request-display-mode'
            );
            expect(requests.map(request => request.params!.mode)).toEqual(['fullscreen']);
            expect((await viewer.expandControl()).label).toBe('Exit full screen');
        });

        it('asks to go back inline once it is full screen', async () => {
            const { viewer } = await painting();
            await viewer.clickExpand();
            await until(
                'the app to show it is full screen',
                () => viewer.expandControl(),
                control => control.label === 'Exit full screen'
            );

            await viewer.clickExpand();

            await until(
                'the app to show it is inline again',
                () => viewer.expandControl(),
                control => control.label === 'Full screen'
            );
            const modes = (await viewer.log()).messages
                .filter(message => message.method === 'ui/request-display-mode')
                .map(message => message.params!.mode);
            expect(modes).toEqual(['fullscreen', 'inline']);
        });

        it('stops offering full screen when the host keeps it inline anyway', async () => {
            // The host answers with the mode it actually set. A control that does nothing twice is
            // worse than no control, so the app takes it away rather than leave it there.
            const { viewer } = await painting({ host: { grantsDisplayMode: false } });

            await viewer.clickExpand();

            const control = await until(
                'the app to withdraw the control',
                () => viewer.expandControl(),
                shown => shown.hidden
            );
            expect(control.hidden).toBe(true);
        });

        it('prefers the session the host pushed over asking for one', async () => {
            const { viewer } = await connected();
            const log = await viewer.log();

            const calls = log.messages.filter(message => message.method === 'tools/call');
            expect(calls).toHaveLength(1);
            expect(calls[0]!.params!.arguments).toEqual({ session_id: SESSION_ID });
        });

        it('falls back through its protocol versions until the host accepts one', async () => {
            const cdp = await startCdp();
            const host = await startHost({
                acceptedProtocolVersions: ['2025-06-18'],
                liveView: { kind: 'ok', cdpUrl: cdp.url },
            });
            const viewer = await openViewer(host);
            await viewer.pushToolResult({ session_id: SESSION_ID });
            await cdp.waitForConnection();

            const log = await viewer.log();
            expect(log.messages.map(message => message.method)).toEqual([
                'ui/initialize',
                'ui/initialize',
                'ui/initialize',
                'ui/notifications/initialized',
                'tools/call',
                // Sent once the live view names the page's shape: the host sizes an inline view for
                // a card, and a browser needs the height its aspect ratio implies.
                'ui/notifications/size-changed',
            ]);
            expect(
                log.messages.filter(message => message.method === 'ui/initialize').map(m => m.params!.protocolVersion)
            ).toEqual(['2026-01-26', '2025-11-25', '2025-06-18']);
            expect(log.violations).toEqual([]);
        });

        it('says it could not reach the host when the host accepts no version at all', async () => {
            const cdp = await startCdp();
            const host = await startHost({ acceptedProtocolVersions: [], liveView: { kind: 'ok', cdpUrl: cdp.url } });
            const viewer = await openViewer(host);
            await viewer.pushToolResult({ session_id: SESSION_ID });

            const screen = await until(
                'the handshake failure to be shown',
                () => viewer.screen(),
                shown => shown.headline !== 'Waiting for a browser session'
            );
            expect(screen.headline).toBe('This app could not reach the chat host');
            expect(screen.spinHidden).toBe(true);
            expect(cdp.connectionCount).toBe(0);
        });

        it('answers a teardown request, stops the screencast and closes the socket', async () => {
            const { cdp, viewer } = await painting();

            await viewer.requestTeardown(77);
            const [stop] = await cdp.waitFor('Page.stopScreencast');

            expect(stop!.sessionId).toBe('page-session-1');
            await until(
                'the app to close its socket',
                async () => cdp.closedByApp,
                closed => closed
            );
            expect((await viewer.log()).responses).toEqual([{ id: 77, result: {} }]);
            expect(cdp.violations).toEqual([]);
        });

        it('stops the screencast when the page it lives on goes away', async () => {
            const { cdp, viewer } = await painting();

            await viewer.page.navigateAway();

            await cdp.waitFor('Page.stopScreencast');
            await until(
                'the app to close its socket',
                async () => cdp.closedByApp,
                closed => closed
            );
        });
    });

    describe('asking for the live view', () => {
        it('reads the session out of a pushed tool result and asks for that live view', async () => {
            const { cdp, viewer } = await connected();
            const log = await viewer.log();

            const call = log.messages.find(message => message.method === 'tools/call');
            expect(call!.params).toEqual({
                name: SESSION_VIEWER_LIVE_VIEW_TOOL,
                arguments: { session_id: SESSION_ID },
            });
            // The query is the credential, so the app has to open the URL exactly as it was issued.
            expect(`wss://127.0.0.1:0${cdp.connectedPaths[0]}`).toBe(cdp.url.replace(/:\d+/, ':0'));
        });

        it('ignores a pushed result with no session in it and waits for a real one', async () => {
            const cdp = await startCdp();
            const host = await startHost({ liveView: { kind: 'ok', cdpUrl: cdp.url } });
            const viewer = await openViewer(host);

            await viewer.pushToolResult({ status: 'live', url: 'https://example.com' });
            await viewer.pushToolResult({ session_id: SESSION_ID });
            await cdp.waitForConnection();

            const calls = (await viewer.log()).messages.filter(message => message.method === 'tools/call');
            expect(calls).toHaveLength(1);
            expect(calls[0]!.params!.arguments).toEqual({ session_id: SESSION_ID });
        });

        it('stays with the first session it was given', async () => {
            const { cdp, viewer } = await connected();

            await viewer.pushToolResult({ session_id: 'sess-a-different-one' });
            await new Promise(resolve => setTimeout(resolve, 300));

            expect((await viewer.log()).messages.filter(message => message.method === 'tools/call')).toHaveLength(1);
            expect(cdp.connectionCount).toBe(1);
        });

        it('repeats what the tool said when the tool reports failure', async () => {
            const cdp = await startCdp();
            const host = await startHost({
                liveView: { kind: 'tool-error', message: 'This session has already been released.' },
            });
            const viewer = await openViewer(host);
            await viewer.pushToolResult({ session_id: SESSION_ID });

            const screen = await until(
                'the live-view failure to be shown',
                () => viewer.screen(),
                shown => shown.headline === 'The live view is unavailable'
            );
            expect(screen.note).toBe('This session has already been released.');
            expect(cdp.connectionCount).toBe(0);
        });

        it('says so plainly when the tool answers with no connection details', async () => {
            const host = await startHost({ liveView: { kind: 'no-details' } });
            const viewer = await openViewer(host);
            await viewer.pushToolResult({ session_id: SESSION_ID });

            const screen = await until(
                'the live-view failure to be shown',
                () => viewer.screen(),
                shown => shown.headline === 'The live view is unavailable'
            );
            expect(screen.note).toBe('The live view tool returned no connection details.');
        });

        it('refuses an address that is not a wss URL before it opens anything', async () => {
            const cdp = await startCdp();
            const host = await startHost({
                liveView: { kind: 'ok', cdpUrl: cdp.url.replace('wss://', 'ws://') },
            });
            const viewer = await openViewer(host);
            await viewer.pushToolResult({ session_id: SESSION_ID });

            const screen = await until(
                'the address to be refused',
                () => viewer.screen(),
                shown => shown.headline === 'The live view is unavailable'
            );
            expect(screen.note).toBe('The live view address was refused before anything was opened.');
            expect(cdp.connectionCount).toBe(0);
        });

        it('does not call a connection that never opened a disconnection', async () => {
            const host = await startHost({
                liveView: { kind: 'ok', cdpUrl: 'wss://127.0.0.1:1/nothing-is-listening-here' },
            });
            const viewer = await openViewer(host);
            await viewer.pushToolResult({ session_id: SESSION_ID });

            const screen = await until(
                'the failed connection to be reported',
                () => viewer.screen(),
                shown => shown.headline !== 'Connecting to the browser'
            );
            expect(screen.headline).toBe('The live view is unavailable');
            expect(screen.note).toBe('The browser connection could not be opened. The chat host may not permit it.');
        });

        it('reports a socket the host CSP forbids instead of waiting on it for ever', async () => {
            // The likeliest live misconfiguration: a host whose declared connect origins do not
            // include the deployment's CDP host. Chrome closes such a socket before it touches the
            // network and fires an error and no close, so this is the only thing that can report it.
            const cdp = await startCdp();
            const host = await startHost({
                appCsp: "connect-src 'none'",
                liveView: { kind: 'ok', cdpUrl: cdp.url },
            });
            const viewer = await openViewer(host);
            await viewer.pushToolResult({ session_id: SESSION_ID });

            const screen = await until(
                'the refused connection to be reported',
                () => viewer.screen(),
                shown => shown.headline === 'The live view is unavailable'
            );
            expect(screen.note).toBe('The browser connection could not be opened. The chat host may not permit it.');
            expect(screen.spinHidden, 'a spinner would say it is still trying').toBe(true);
            expect(cdp.connectionCount).toBe(0);
        });
    });

    describe('attaching over CDP', () => {
        it('picks the real page, attaches flat and starts the screencast inside that session', async () => {
            const { cdp } = await connected();
            await cdp.waitFor('Page.startScreencast');

            expect(cdp.methods).toEqual([
                'Target.getTargets',
                'Target.attachToTarget',
                'Page.enable',
                'DOM.enable',
                'Runtime.enable',
                'Page.setInterceptFileChooserDialog',
                'Page.startScreencast',
            ]);
            const [getTargets, attach, enable, dom, runtime, chooser, start] = cdp.received;
            expect(getTargets!.sessionId, 'the first command has no session to run in yet').toBeUndefined();
            expect(attach!.params).toEqual({ targetId: 'page-1', flatten: true });
            expect(enable!.sessionId).toBe('page-session-1');
            expect(dom!.sessionId).toBe('page-session-1');
            expect(runtime!.sessionId).toBe('page-session-1');
            expect(chooser!.params).toEqual({ enabled: true });
            expect(start!.sessionId).toBe('page-session-1');
            expect(start!.params).toMatchObject({ format: 'jpeg', everyNthFrame: 1 });
            // The fake endpoint refuses any page-scoped command that arrives without the session id.
            expect(cdp.violations).toEqual([]);
        });

        it('gives up when the browser offers no page it can show', async () => {
            const { viewer } = await connected({
                cdp: { targets: [{ targetId: 'devtools-1', type: 'page', url: 'devtools://devtools/x.html' }] },
            });

            const screen = await until(
                'the missing page to be reported',
                () => viewer.screen(),
                shown => shown.headline === 'The live view is unavailable'
            );
            expect(screen.note).toBe('the session has no page to show');
        });

        it('gives up when the browser does not attach to the page', async () => {
            const { viewer } = await connected({ cdp: { attachedSessionId: null } });

            const screen = await until(
                'the failed attach to be reported',
                () => viewer.screen(),
                shown => shown.headline === 'The live view is unavailable'
            );
            expect(screen.note).toBe('the browser did not attach to the page');
        });

        it('repeats what the browser said when it refuses a command', async () => {
            const { viewer } = await connected({
                cdp: { refuse: { 'Page.startScreencast': 'Screencast is not available on this target.' } },
            });

            const screen = await until(
                'the refusal to be reported',
                () => viewer.screen(),
                shown => shown.headline === 'The live view is unavailable'
            );
            expect(screen.note).toBe('Screencast is not available on this target.');
        });

        it('ignores a socket payload that is not the JSON a screencast sends', async () => {
            const { cdp, viewer } = await connected();
            await cdp.waitFor('Page.startScreencast');

            cdp.sendRaw(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
            cdp.sendRaw('this is not JSON at all');
            cdp.sendRaw(JSON.stringify(['an array is not a CDP message']));

            cdp.sendFrame(magentaJpeg);
            const canvas = await until(
                'the app to carry on and paint the next real frame',
                () => viewer.canvas(),
                shown => isColour(shown.centre, MAGENTA)
            );
            expect(canvas.width).toBe(JPEG_WIDTH);
            expect(viewer.page.appExceptions).toEqual([]);
        });

        it('times out a command the browser never answers', async () => {
            const { viewer } = await connected({ cdp: { stall: ['Target.getTargets'] } });

            // The app allows a command 15s, so this waits it out rather than mocking the clock.
            const screen = await until(
                'the stalled command to time out',
                () => viewer.screen(),
                shown => shown.headline === 'The live view is unavailable',
                25_000
            );
            expect(screen.note).toBe('Target.getTargets timed out');
        });
    });

    describe('painting frames', () => {
        it('decodes a frame, sizes the canvas to it and draws it', async () => {
            const { viewer } = await painting();

            const canvas = await viewer.canvas();
            expect(canvas).toMatchObject({ width: JPEG_WIDTH, height: JPEG_HEIGHT });
            expect(isColour(canvas.centre, MAGENTA), `centre pixel was ${canvas.centre}`).toBe(true);
            const screen = await viewer.screen();
            expect(screen).toMatchObject({ badge: 'Live', veilHidden: true, badgeHidden: false });
            expect(viewer.page.appExceptions).toEqual([]);
        });

        it('acknowledges every frame with the integer session id the ack command takes', async () => {
            const { cdp, viewer } = await connected();
            await cdp.waitFor('Page.startScreencast');

            const sent = [
                cdp.sendFrame(magentaJpeg),
                cdp.sendFrame(magentaJpeg),
                cdp.sendFrame(magentaJpeg),
                cdp.sendFrame(magentaJpeg),
            ];
            await cdp.waitFor('Page.screencastFrameAck', 4);

            expect(cdp.acks).toEqual(sent);
            expect(cdp.acks.every(Number.isInteger), `acks were ${JSON.stringify(cdp.acks)}`).toBe(true);
            // A refused ack is how the stream stalls, so the endpoint checking the type matters here.
            expect(cdp.violations).toEqual([]);
            expect(viewer.page.appExceptions).toEqual([]);
        });

        it('acknowledges a frame it cannot decode, so one bad frame cannot stall the stream', async () => {
            const { cdp, viewer } = await connected();
            await cdp.waitFor('Page.startScreencast');

            // Well-formed base64 that is not an image at all: the ack must not wait on the decode.
            cdp.sendFrame('AAAA'.repeat(24));
            await cdp.waitFor('Page.screencastFrameAck', 1);

            expect((await viewer.screen()).headline).toBe('Waiting for the first frame');
            expect((await viewer.canvas()).centre, 'nothing may be drawn from a frame that failed').toEqual([
                0, 0, 0, 0,
            ]);

            cdp.sendFrame(magentaJpeg);
            const canvas = await until(
                'the next good frame to paint',
                () => viewer.canvas(),
                shown => isColour(shown.centre, MAGENTA)
            );
            expect(canvas.width).toBe(JPEG_WIDTH);
            expect(cdp.acks).toEqual([1, 2]);
        });

        it('paints each new frame over the last', async () => {
            const { cdp, viewer } = await painting();

            cdp.sendFrame(cyanJpeg);

            const canvas = await until(
                'the second frame to replace the first',
                () => viewer.canvas(),
                shown => isColour(shown.centre, CYAN)
            );
            expect(canvas).toMatchObject({ width: JPEG_WIDTH, height: JPEG_HEIGHT });
        });

        it('holds the aspect ratio the tool reported until the frames say otherwise', async () => {
            const { cdp, viewer } = await connected();
            await cdp.waitFor('Page.startScreencast');

            expect(await viewer.aspectRatio(), 'the reported 1600x1000 viewport').toBe('1.6');

            cdp.sendFrame(magentaJpeg, frameMetadata({ deviceWidth: 1024, deviceHeight: 768 }));
            const ratio = await until(
                'the captured aspect ratio to take over',
                () => viewer.aspectRatio(),
                value => value !== '1.6'
            );
            expect(ratio).toBe(String(1024 / 768));
        });
    });

    describe('the phases a user notices', () => {
        it('waits for a session, then for a frame, then goes live', async () => {
            const cdp = await startCdp();
            const host = await startHost({ liveView: { kind: 'ok', cdpUrl: cdp.url } });
            const viewer = await openViewer(host);

            expect(await viewer.screen()).toMatchObject({
                headline: 'Waiting for a browser session',
                veilHidden: false,
                spinHidden: false,
            });

            await viewer.pushToolResult({ session_id: SESSION_ID });
            await until(
                'the wait for a first frame',
                () => viewer.screen(),
                shown => shown.headline === 'Waiting for the first frame'
            );
            expect((await viewer.screen()).note).toBe('The page has not repainted yet.');

            cdp.sendFrame(magentaJpeg);
            const live = await until(
                'the live badge',
                () => viewer.screen(),
                shown => shown.veilHidden && shown.badge !== ''
            );
            expect(live.badge).toBe('Live');
        });

        it('calls a page that has stopped repainting idle, and not broken', async () => {
            const { viewer } = await painting();

            // No further frames: a repaint-driven stream sends nothing while a page sits still, and
            // the app has to notice that from its clock. It allows 1.5s, plus a 400ms render tick.
            const idle = await until(
                'the idle badge',
                () => viewer.screen(),
                shown => shown.badge !== 'Live',
                SESSION_VIEWER_IDLE_AFTER_MS + 4_000
            );

            expect(idle.badge).toBe('Live, page idle');
            expect(idle.badge, 'an idle page must not read as a fault').not.toMatch(
                /error|fail|lost|broken|disconnect|unavailable/i
            );
            expect(idle.veilHidden, 'the frame stays visible while the page is idle').toBe(true);
        });

        it('says the live view disconnected when the browser socket drops', async () => {
            const { cdp, viewer } = await painting();

            cdp.dropConnection();

            const closed = await until(
                'the disconnection to be shown',
                () => viewer.screen(),
                shown => !shown.veilHidden
            );
            expect(closed).toMatchObject({
                headline: 'The live view disconnected',
                note: 'The connection to the browser closed. The session may have ended.',
                spinHidden: true,
            });
        });

        it('says the live view expired once its access window passes', async () => {
            const { viewer } = await painting({ expiresAt: Date.now() + 2_000 });

            expect((await viewer.screen()).badge).toBe('Live');

            // Nothing happens on the wire at expiry; only the app's own render tick can notice it.
            const expired = await until(
                'the expiry to be shown',
                () => viewer.screen(),
                shown => !shown.veilHidden,
                8_000
            );
            expect(expired).toMatchObject({
                headline: 'This live view expired',
                note: 'Its access window has passed. Start a new session to watch again.',
                spinHidden: true,
            });
        });

        it('says out loud when the host neither sends a session nor answers the ask', async () => {
            const host = await startHost({ liveView: { kind: 'silent' } });
            const viewer = await openViewer(host);

            expect((await viewer.screen()).note).toBe('');

            // With nothing pushed, the app asks the server which session it is showing. This host
            // never answers, so what is left to report is the host's own silence — and it takes the
            // app's 15s call timeout to know that.
            const waiting = await until(
                'the app to say the ask went unanswered',
                () => viewer.screen(),
                shown => shown.note !== '',
                25_000
            );
            expect(waiting.note).toContain('got no answer from the host');
        });
    });

    describe('what must never happen', () => {
        it('keeps the drive-capable CDP address out of the rendered document', async () => {
            const { cdp, viewer } = await painting();

            const html = await viewer.documentHtml();
            expect(html).toContain('Steel live browser session');
            expect(html).not.toContain(cdp.token);
            expect(html).not.toContain('wss://127.0.0.1');
            expect(html).not.toContain('token=');
        });

        it('strips a credential out of a failure message before showing it', async () => {
            const secret = 'eyJhbGciOiJIUzI1NiJ9.aaaaaaaa.bbbbbbbb';
            const host = await startHost({
                liveView: { kind: 'tool-error', message: `could not reach wss://connect.steel.dev/x?token=${secret}` },
            });
            const viewer = await openViewer(host);
            await viewer.pushToolResult({ session_id: SESSION_ID });

            const screen = await until(
                'the scrubbed failure to be shown',
                () => viewer.screen(),
                shown => shown.note !== ''
            );
            expect(screen.note).toBe('could not reach wss://connect.steel.dev/x');
            expect(await viewer.documentHtml()).not.toContain(secret);
        });

        it('sends the browser no input when the canvas is clicked', async () => {
            const { cdp, viewer } = await painting();

            // Take-control is off by default: the mode says so, and a click reaches nothing on the wire.
            expect(await viewer.driving()).toBe(false);
            expect(await viewer.modeLabel()).toBe('Watching (read-only)');

            await viewer.page.clickAt(400, 250);
            await new Promise(resolve => setTimeout(resolve, 400));

            expect(cdp.methods.filter(method => method.startsWith('Input.'))).toEqual([]);
        });

        it('maps a canvas point into the live page, and a point outside it to nothing', async () => {
            const { cdp, viewer } = await connected();
            await cdp.waitFor('Page.startScreencast');

            expect(await viewer.mapPoint(400, 250), 'nothing is mappable before a frame arrives').toBe(null);

            cdp.sendFrame(magentaJpeg, frameMetadata({ scrollOffsetX: 100, scrollOffsetY: 200 }));
            await until(
                'a frame to give the mapping something to work from',
                () => viewer.mapPoint(400, 250),
                point => point !== null
            );

            const centre = (await viewer.mapPoint(400, 250)) as { viewportX: number; pageX: number; pageY: number };
            expect(centre.viewportX, 'the middle of the canvas is the middle of the 1024px page').toBeGreaterThan(430);
            expect(centre.viewportX).toBeLessThan(600);
            expect(centre.pageX, 'the document point adds the page scroll').toBe(centre.viewportX + 100);
            expect(await viewer.mapPoint(2, 2), 'the letterbox beside the frame is not in the page').toBe(null);
        });
    });

    describe('take-control: forwarding real input over CDP', () => {
        it('offers the toggle once attached, and switches its visible state when driven', async () => {
            const { viewer } = await painting();

            expect(await viewer.modeLabel(), 'read-only is the safe default').toBe('Watching (read-only)');

            await viewer.takeControl();
            expect(await viewer.driving()).toBe(true);
            expect(await viewer.modeLabel()).toBe('You are driving this browser');

            await viewer.handBack();
            expect(await viewer.driving()).toBe(false);
            expect(await viewer.modeLabel()).toBe('Watching (read-only)');
            expect(viewer.page.appExceptions).toEqual([]);
        });

        it('moves a user-picked local file directly into the remote file input without an MCP payload', async () => {
            const { cdp, viewer } = await painting();
            await viewer.takeControl();
            cdp.sendFileChooser(42);
            await until(
                'the trusted local file control to appear',
                () => viewer.fileControl(),
                shown => !shown.hidden
            );

            await viewer.selectLocalFile('cv.pdf', 'hello', 'application/pdf');
            const [install] = await cdp.waitFor('Runtime.callFunctionOn');
            expect(install!.params.objectId).toBe('remote-file-input-1');
            expect(install!.params.arguments).toEqual([
                { value: 'aGVsbG8=' },
                { value: 'cv.pdf' },
                { value: 'application/pdf' },
            ]);
            await until(
                'the local file control to close',
                () => viewer.fileControl(),
                shown => shown.hidden
            );

            const bridge = JSON.stringify((await viewer.log()).messages);
            expect(bridge).not.toContain('cv.pdf');
            expect(bridge).not.toContain('aGVsbG8=');
            expect(viewer.page.appExceptions).toEqual([]);
        });

        it('forwards a canvas click as a pressed and released mouse event with the mapped point', async () => {
            const { cdp, viewer } = await painting();
            await viewer.takeControl();

            const probe = await viewer.driveClick(0.5, 0.5);
            await cdp.waitFor('Input.dispatchMouseEvent', 2);

            const inputs = cdp.inputCommands;
            expect(inputs.map(cmd => cmd.params.type)).toEqual(['mousePressed', 'mouseReleased']);
            const pressed = inputs[0]!.params as {
                x: number;
                y: number;
                button: string;
                buttons: number;
                clickCount: number;
            };
            expect(probe, 'the centre of the canvas maps into the page').not.toBe(null);
            expect(pressed.x).toBe((probe as { viewportX: number }).viewportX);
            expect(pressed.y).toBe((probe as { viewportY: number }).viewportY);
            expect(pressed).toMatchObject({ button: 'left', buttons: 1, clickCount: 1 });
            expect(viewer.page.appExceptions).toEqual([]);
        });

        it('raises the click count for a double click', async () => {
            const { cdp, viewer } = await painting();
            await viewer.takeControl();

            await viewer.driveClick(0.5, 0.5, 2);
            const [pressed] = await cdp.waitFor('Input.dispatchMouseEvent');
            expect((pressed!.params as { clickCount: number }).clickCount).toBe(2);
        });

        it('forwards a wheel event as a mouseWheel carrying the deltas', async () => {
            const { cdp, viewer } = await painting();
            await viewer.takeControl();

            await viewer.driveWheel(0.5, 0.5, 3, 24);
            const [wheel] = await cdp.waitFor('Input.dispatchMouseEvent');
            expect(wheel!.params).toMatchObject({ type: 'mouseWheel', deltaX: 3, deltaY: 24 });
        });

        it('forwards a key as a keyDown dispatch, and inserts text only for a printable char', async () => {
            const { cdp, viewer } = await painting();
            await viewer.takeControl();

            await viewer.driveKey('keydown', 'a', 'KeyA');
            await cdp.waitFor('Input.dispatchKeyEvent');
            await cdp.waitFor('Input.insertText');

            const keyDown = cdp.inputCommands.find(cmd => cmd.method === 'Input.dispatchKeyEvent')!.params as Record<
                string,
                unknown
            >;
            expect(keyDown).toEqual({
                type: 'keyDown',
                key: 'a',
                code: 'KeyA',
                windowsVirtualKeyCode: 65,
                modifiers: 0,
            });
            expect(cdp.inputCommands.find(cmd => cmd.method === 'Input.insertText')!.params).toEqual({ text: 'a' });

            // Enter is a control key: a keyDown is forwarded, but no text is inserted.
            const before = cdp.inputCommands.length;
            await viewer.driveKey('keydown', 'Enter', 'Enter');
            await cdp.waitFor('Input.dispatchKeyEvent', 2);
            await new Promise(resolve => setTimeout(resolve, 150));

            expect(cdp.inputCommands.length, 'Enter added exactly one keyDown').toBe(before + 1);
            expect(cdp.inputCommands.at(-1)!.method).toBe('Input.dispatchKeyEvent');
            expect((cdp.inputCommands.at(-1)!.params as { windowsVirtualKeyCode: number }).windowsVirtualKeyCode).toBe(
                13
            );
            expect(
                cdp.inputCommands.filter(cmd => cmd.method === 'Input.insertText').length,
                'only the earlier a was inserted'
            ).toBe(1);
            expect(viewer.page.appExceptions).toEqual([]);
        });

        it('stops forwarding the moment control is handed back', async () => {
            const { cdp, viewer } = await painting();
            await viewer.takeControl();
            await viewer.driveClick(0.5, 0.5);
            await cdp.waitFor('Input.dispatchMouseEvent', 2);
            const forwardedWhileDriving = cdp.inputCommands.length;
            expect(forwardedWhileDriving).toBeGreaterThan(0);

            await viewer.handBack();
            await viewer.driveClick(0.5, 0.5);
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(cdp.inputCommands.length, 'no further input after hand-back').toBe(forwardedWhileDriving);
            expect(viewer.page.appExceptions).toEqual([]);
        });

        it('forwards nothing for a click the canvas-to-page mapping rejects', async () => {
            const { cdp, viewer } = await painting();
            await viewer.takeControl();

            const probe = await viewer.driveLetterboxMouseDown();
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(probe, 'the point is outside the live page').toBe(null);
            expect(cdp.inputCommands).toEqual([]);
            expect(viewer.page.appExceptions).toEqual([]);
        });

        it('keeps the drive-capable CDP address out of the document after a control session', async () => {
            const { cdp, viewer } = await painting();
            await viewer.takeControl();
            await viewer.driveClick(0.5, 0.5);
            await viewer.driveKey('keydown', 'a', 'KeyA');
            await cdp.waitFor('Input.dispatchMouseEvent');

            const html = await viewer.documentHtml();
            expect(html).not.toContain(cdp.token);
            expect(html).not.toContain('token=');
            expect(html).not.toMatch(/wss:\/\/127\.0\.0\.1/);
        });
    });
});
