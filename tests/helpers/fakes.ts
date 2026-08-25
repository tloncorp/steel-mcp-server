// ABOUTME: Test doubles injected at the Steel client and browser-pool boundaries, so the whole tool
// ABOUTME: surface can be driven through a real MCP client without a network or a browser.
import type { Tracer } from '@opentelemetry/api';
import { loadConfig, type SteelConfig } from '../../src/core/config.js';
import type { ServerDeps, SessionPool } from '../../src/core/context.js';
import { createHandoffCodec } from '../../src/core/mrtr.js';
import { BrowserPage } from '../../src/core/page.js';
import { type HandleRegistry, InMemoryHandleRegistry, principalFromCredential } from '../../src/core/registry.js';
import { createSessionPlanCodec } from '../../src/core/session-plan.js';
import type {
    AccountDetails,
    AgentTraceTimeline,
    ArtifactRequest,
    ArtifactResponse,
    CreateSessionRequest,
    ScrapeRequest,
    ScrapeResponse,
    SessionListRequest,
    SessionListResponse,
    SessionLogTimeline,
    SteelApi,
    SteelCredentialSummary,
    SteelProfileSummary,
    SteelSession,
} from '../../src/core/steel/types.js';
import { recordSessionReleased, resolveTracer } from '../../src/core/telemetry.js';
import { type FixturePage, fixtureSession } from './cdp-fixture.js';

export interface FakeSteelApiOptions {
    scrape?: Partial<ScrapeResponse> | (() => Promise<ScrapeResponse>);
    details?: AccountDetails;
    traces?: AgentTraceTimeline;
    logs?: SessionLogTimeline;
    sessions?: SessionListResponse;
    profiles?: SteelProfileSummary[];
    credentials?: SteelCredentialSummary[];
    failTracesWith?: Error;
    failLogsWith?: Error;
    failCreateWith?: Error;
    /** Overrides the live-player URL; `null` models a deployment that returns none at all. */
    debugUrl?: string | null;
    /**
     * Overrides the scoped CDP URL a session read answers with; `null` models a deployment that
     * returns none. Steel re-mints the token on every read, so the fake stamps the call count into
     * it and a test can tell one fetch from the next.
     */
    websocketUrl?: string | null;
    /** Overrides the session's viewport; `null` models a session Steel reports no dimensions for. */
    dimensions?: { width: number; height: number } | null;
    failGetSessionWith?: Error;
    /** Exact metadata (or failure) returned for a historical session id. */
    sessionsById?: Record<string, SteelSession | Error>;
    /** Exact HLS manifest (or failure) returned for a historical session id. */
    hlsBySession?: Record<string, string | Error>;
}

/** The viewport a session read reports unless a test asks for another one. */
export const FAKE_VIEWPORT = { width: 1280, height: 720 };

/** Records every call so tests can assert on the wire shape without a network. */
export class FakeSteelApi implements SteelApi {
    readonly created: CreateSessionRequest[] = [];
    readonly released: string[] = [];
    readonly scrapes: ScrapeRequest[] = [];
    readonly artifacts: ArtifactRequest[] = [];
    /** Every `GET /v1/sessions/{id}`, in order, so a test can prove a URL was fetched afresh. */
    readonly sessionReads: string[] = [];
    /** Every `GET /v1/sessions/{id}/hls`, kept separately from metadata reads. */
    readonly hlsReads: string[] = [];
    /** Every historical-session listing request, in order. */
    readonly sessionLists: SessionListRequest[] = [];
    readonly credentialLists: Array<{ origin: string; namespace?: string }> = [];
    /** Session ids sent to the two diagnostics endpoints, kept separately to catch wrong-session reads. */
    readonly traceReads: string[] = [];
    readonly logReads: string[] = [];

    constructor(private readonly options: FakeSteelApiOptions = {}) {}

    async scrape(request: ScrapeRequest): Promise<ScrapeResponse> {
        this.scrapes.push(request);
        if (typeof this.options.scrape === 'function') return this.options.scrape();
        return {
            content: { markdown: '# Example\n\nHello world.' },
            links: [{ url: 'https://example.com/about', text: 'About' }],
            metadata: { statusCode: 200, title: 'Example', urlSource: 'https://example.com/' },
            ...this.options.scrape,
        };
    }

    async screenshot(request: ArtifactRequest): Promise<ArtifactResponse> {
        this.artifacts.push(request);
        return { kind: 'hosted', url: 'https://files.steel.dev/v1/static/shot.png' };
    }

    async pdf(request: ArtifactRequest): Promise<ArtifactResponse> {
        this.artifacts.push(request);
        return { kind: 'hosted', url: 'https://files.steel.dev/v1/static/doc.pdf' };
    }

    async createSession(request: CreateSessionRequest): Promise<SteelSession> {
        if (this.options.failCreateWith) throw this.options.failCreateWith;
        this.created.push(request);
        return {
            id: request.sessionId,
            status: 'live',
            createdAt: '2026-07-27T10:00:00.000Z',
            profileId:
                request.profileId ?? (request.persistProfile ? '11111111-1111-4111-8111-111111111111' : undefined),
            sessionViewerUrl: `https://app.steel.dev/sessions/${request.sessionId}`,
            // The self-contained player, which is what a person without a Steel login can open.
            debugUrl:
                this.options.debugUrl === null
                    ? undefined
                    : (this.options.debugUrl ?? `https://api.steel.dev/v1/sessions/${request.sessionId}/player`),
        };
    }

    async releaseSession(sessionId: string): Promise<void> {
        this.released.push(sessionId);
    }

    /**
     * Answers a session read the way Steel does: with a `websocketUrl` carrying a freshly minted
     * session-scoped token, and the dimensions the session was created with.
     */
    async getSession(sessionId: string): Promise<SteelSession> {
        if (this.options.failGetSessionWith) throw this.options.failGetSessionWith;
        this.sessionReads.push(sessionId);
        const configured = this.options.sessionsById?.[sessionId];
        if (configured instanceof Error) throw configured;
        if (configured) return configured;
        const websocketUrl =
            this.options.websocketUrl === null
                ? undefined
                : (this.options.websocketUrl ??
                  `wss://connect.steel.dev/?sessionId=${sessionId}&token=jwt-${this.sessionReads.length}`);
        return {
            id: sessionId,
            status: 'live',
            websocketUrl,
            dimensions: this.options.dimensions === null ? undefined : (this.options.dimensions ?? FAKE_VIEWPORT),
        };
    }

    /** Answers the finished-session recording endpoint without putting its manifest in session metadata. */
    async getSessionHls(sessionId: string): Promise<string> {
        this.hlsReads.push(sessionId);
        const configured = this.options.hlsBySession?.[sessionId];
        if (configured instanceof Error) throw configured;
        if (typeof configured === 'string') return configured;
        throw new Error(`No HLS fixture configured for Steel session ${sessionId}.`);
    }

    async getDetails(): Promise<AccountDetails> {
        return this.options.details ?? { maxSessionDuration: 900_000, concurrencyLimit: 10, plan: 'launch' };
    }

    async listProfiles(): Promise<SteelProfileSummary[]> {
        return this.options.profiles ?? [];
    }

    async getProfile(profileId: string): Promise<SteelProfileSummary> {
        const found = this.options.profiles?.find(item => item.id === profileId);
        if (!found) throw new Error('Profile not found');
        return found;
    }

    async listCredentials(request: { origin: string; namespace?: string }): Promise<SteelCredentialSummary[]> {
        this.credentialLists.push(request);
        return (this.options.credentials ?? []).filter(
            item =>
                item.origin === request.origin &&
                (request.namespace === undefined || item.namespace === request.namespace)
        );
    }

    async listSessions(request: SessionListRequest): Promise<SessionListResponse> {
        this.sessionLists.push(request);
        return this.options.sessions ?? { sessions: [], nextCursor: null };
    }

    /** Answers with the `{events,total,hasMore}` envelope and the field names Steel really sends. */
    async getAgentTraces(sessionId: string): Promise<AgentTraceTimeline> {
        this.traceReads.push(sessionId);
        if (this.options.failTracesWith) throw this.options.failTracesWith;
        return (
            this.options.traces ?? {
                events: [
                    {
                        timestamp: '2026-07-27T10:00:01.000Z',
                        type: 'click',
                        page: { url: 'https://example.com/login' },
                        target: {
                            tagName: 'BUTTON',
                            role: 'button',
                            accessibleName: 'Sign in',
                            attributes: { id: 'signin', name: 'signin', type: 'submit' },
                            selector: { css: 'button.signin', id: 'signin', name: 'signin' },
                            boundingBox: { x: 100, y: 200, width: 80, height: 40 },
                        },
                        pointer: { x: 520, y: 410 },
                    },
                    {
                        timestamp: '2026-07-27T10:00:02.000Z',
                        type: 'navigate',
                        navigation: { url: 'https://example.com/challenge' },
                    },
                ],
                total: 2,
                hasMore: false,
            }
        );
    }

    /**
     * Answers with the same envelope, entries that name themselves with `type`, and `log` as the
     * JSON-encoded string it really is. The routine Request and Response pair is here on purpose:
     * a real page load buries the two useful entries under dozens of them.
     */
    async getSessionLogs(sessionId: string): Promise<SessionLogTimeline> {
        this.logReads.push(sessionId);
        if (this.options.failLogsWith) throw this.options.failLogsWith;
        return (
            this.options.logs ?? {
                events: [
                    {
                        id: 'fake-0-1',
                        type: 'Navigation',
                        timestamp: '2026-07-27T10:00:00.500Z',
                        log: JSON.stringify({
                            pageId: 'ED45',
                            navigation: { url: 'https://example.com/login' },
                            createdAt: 1_785_428_340_864,
                        }),
                    },
                    {
                        id: 'fake-0-2',
                        type: 'Request',
                        timestamp: '2026-07-27T10:00:00.700Z',
                        log: JSON.stringify({ pageId: 'ED45', request: { url: 'https://example.com/app.js' } }),
                    },
                    {
                        id: 'fake-0-3',
                        type: 'Response',
                        timestamp: '2026-07-27T10:00:00.800Z',
                        log: JSON.stringify({
                            pageId: 'ED45',
                            response: { url: 'https://example.com/app.js', status: 200 },
                        }),
                    },
                    {
                        id: 'fake-0-4',
                        type: 'RequestFailed',
                        timestamp: '2026-07-27T10:00:03.000Z',
                        log: JSON.stringify({
                            pageId: '15F9',
                            error: { message: 'net::ERR_ABORTED', url: 'https://ads.test/adsbygoogle.js' },
                            createdAt: 1_785_496_290_115,
                        }),
                    },
                ],
                total: 4,
                hasMore: false,
            }
        );
    }
}

/** Hands out BrowserPage instances backed by the CDP fixture, one per Steel session id. */
export class FakeSessionPool implements SessionPool {
    readonly closed: string[] = [];
    private readonly pages = new Map<string, BrowserPage>();
    private readonly fixtures = new Map<string, ReturnType<typeof fixtureSession>>();

    constructor(private readonly makePage: () => FixturePage) {}

    async page(steelSessionId: string): Promise<BrowserPage> {
        const existing = this.pages.get(steelSessionId);
        if (existing) return existing;

        const fixture = fixtureSession(this.makePage());
        fixture.stub('DOM.scrollIntoViewIfNeeded', () => ({}));
        fixture.stub('DOM.getBoxModel', () => ({ model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } }));
        fixture.stub('DOM.getNodeForLocation', () => ({ backendNodeId: 10 }));
        fixture.stub('DOM.describeNode', () => ({ node: { nodeName: 'BUTTON', attributes: [] } }));
        fixture.stub('DOM.focus', () => ({}));
        fixture.stub('Input.dispatchMouseEvent', () => ({}));
        fixture.stub('Input.dispatchKeyEvent', () => ({}));
        fixture.stub('Input.insertText', () => ({}));
        fixture.stub('Page.navigate', () => ({ frameId: 'main-frame', loaderId: 'loader-1' }));
        fixture.stub('Page.captureScreenshot', () => ({ data: 'aGVsbG8=' }));

        const page = await BrowserPage.attach(fixture.session, {
            budgets: { navigationWatchMs: 1, navigationMs: 5, mutationQuietMs: 1, mutationMaxMs: 5 },
        });
        this.pages.set(steelSessionId, page);
        this.fixtures.set(steelSessionId, fixture);
        return page;
    }

    fixtureFor(steelSessionId: string) {
        return this.fixtures.get(steelSessionId);
    }

    async close(steelSessionId: string): Promise<void> {
        this.closed.push(steelSessionId);
        this.pages.delete(steelSessionId);
        this.fixtures.delete(steelSessionId);
    }

    async closeAll(): Promise<void> {
        for (const id of [...this.pages.keys()]) await this.close(id);
    }
}

/** The ordinary two-element page the stateful tools are exercised against by default. */
export function plainPage(): FixturePage {
    return {
        root: {
            tag: 'HTML',
            backendNodeId: 1,
            role: 'RootWebArea',
            name: 'Example',
            bounds: [0, 0, 1280, 720],
            children: [
                { tag: 'BUTTON', backendNodeId: 10, role: 'button', name: 'Save', bounds: [100, 200, 80, 40] },
                { tag: 'A', backendNodeId: 11, role: 'link', name: 'About us', bounds: [10, 60, 60, 20] },
            ],
        },
        url: 'https://example.com/',
        loaderId: 'loader-1',
    };
}

/**
 * A login wall: an email field, a password field and a submit button.
 *
 * The password input is what makes this a wall rather than a page with a sign-in link, and the
 * snapshot pipeline is what classifies it as sensitive, so the fixture states the attributes it
 * reads rather than a flag.
 */
export function loginWallPage(url = 'https://app.test/login'): FixturePage {
    return {
        root: {
            tag: 'HTML',
            backendNodeId: 1,
            role: 'RootWebArea',
            name: 'Sign in to Example',
            bounds: [0, 0, 1280, 720],
            children: [
                {
                    tag: 'INPUT',
                    backendNodeId: 20,
                    role: 'textbox',
                    name: 'Email',
                    attributes: { type: 'email', name: 'email' },
                    bounds: [100, 100, 240, 32],
                },
                {
                    tag: 'INPUT',
                    backendNodeId: 21,
                    role: 'textbox',
                    name: 'Password',
                    attributes: { type: 'password', name: 'password', autocomplete: 'current-password' },
                    bounds: [100, 150, 240, 32],
                },
                { tag: 'BUTTON', backendNodeId: 22, role: 'button', name: 'Sign in', bounds: [100, 200, 80, 40] },
            ],
        },
        url,
        title: 'Sign in to Example',
        loaderId: 'loader-login',
    };
}

/**
 * A working shop page whose footer carries a reCAPTCHA v3 badge.
 *
 * The badge iframe is on a large share of the web. The page around it is the point: a grid of
 * products and a basket is a page that works, not a wall a person has to be called in to clear.
 */
export function badgedShopPage(url = 'https://shop.test/products'): FixturePage {
    return {
        root: {
            tag: 'HTML',
            backendNodeId: 1,
            role: 'RootWebArea',
            name: 'Kitchen knives — Shop',
            bounds: [0, 0, 1280, 720],
            children: [
                { tag: 'A', backendNodeId: 10, role: 'link', name: 'Basket (2)', bounds: [1100, 10, 100, 24] },
                {
                    tag: 'INPUT',
                    backendNodeId: 11,
                    role: 'searchbox',
                    name: 'Search products',
                    attributes: { type: 'search', name: 'q' },
                    bounds: [400, 10, 240, 24],
                },
                ...Array.from({ length: 24 }, (_unused, index) => ({
                    tag: 'A',
                    backendNodeId: 100 + index,
                    role: 'link',
                    name: `Santoku knife model ${index}`,
                    bounds: [20, 60 + index * 24, 200, 20] as [number, number, number, number],
                })),
                { tag: 'IFRAME', backendNodeId: 90, role: 'Iframe', name: 'reCAPTCHA', bounds: [1180, 640, 70, 60] },
                {
                    tag: 'SPAN',
                    backendNodeId: 91,
                    role: 'StaticText',
                    name: 'protected by reCAPTCHA',
                    bounds: [1180, 700, 70, 12],
                },
            ],
        },
        url,
        title: 'Kitchen knives — Shop',
        loaderId: 'loader-shop',
    };
}

/** A CAPTCHA challenge page: the widget label is the only thing on it. */
export function captchaPage(url = 'https://shop.test/cart'): FixturePage {
    return {
        root: {
            tag: 'HTML',
            backendNodeId: 1,
            role: 'RootWebArea',
            name: 'Verify you are human',
            bounds: [0, 0, 1280, 720],
            children: [
                {
                    tag: 'DIV',
                    backendNodeId: 30,
                    role: 'checkbox',
                    name: "I'm not a robot",
                    bounds: [100, 100, 300, 74],
                },
            ],
        },
        url,
        title: 'Verify you are human',
        loaderId: 'loader-captcha',
    };
}

export const TEST_API_KEY = 'ste-test-key';

export interface TestDepsOptions {
    api?: SteelApi;
    pool?: SessionPool;
    env?: Record<string, string | undefined>;
    page?: () => FixturePage;
    tracer?: Tracer;
    artifactFetch?: typeof globalThis.fetch;
    /**
     * Handle store to use instead of a fresh in-process one.
     *
     * Pass the same one to two bundles and they become two replicas of one deployment, which is the
     * only way to test what a request routed to a replica that has never seen the handle does.
     */
    registry?: HandleRegistry;
}

/** Assembles the dependency bundle a server needs, with fakes at both external boundaries. */
export function testDeps(options: TestDepsOptions = {}): ServerDeps & {
    api: FakeSteelApi;
    pool: FakeSessionPool;
    config: SteelConfig;
} {
    const config = loadConfig({ STEEL_API_KEY: TEST_API_KEY, ...options.env });
    const api = (options.api as FakeSteelApi) ?? new FakeSteelApi();
    const pool = (options.pool as FakeSessionPool) ?? new FakeSessionPool(options.page ?? plainPage);

    const registry =
        options.registry ??
        new InMemoryHandleRegistry({
            releaseSteelSession: async (id: string) => {
                await pool.close(id);
                await api.releaseSession(id);
            },
            onReleased: cause =>
                recordSessionReleased(resolveTracer(options.tracer), {
                    cause,
                    deployment: config.deployment,
                    registryBackend: 'memory',
                }),
        });

    const principal = principalFromCredential(TEST_API_KEY);
    return {
        config,
        api,
        pool,
        registry,
        handoffState: createHandoffCodec(config.requestStateSecret),
        sessionPlanState: createSessionPlanCodec(config.requestStateSecret, principal),
        principal,
        settleMultiplier: 1,
        // Real time: the registry checks handle expiry against the real clock.
        now: () => new Date(),
        tracer: options.tracer,
        artifactFetch:
            options.artifactFetch ??
            (async input => {
                const url = String(input);
                const pdf = url.endsWith('.pdf');
                return new Response(pdf ? '%PDF-test' : 'fake-png', {
                    headers: {
                        'content-type': pdf ? 'application/pdf' : 'image/png',
                        'content-disposition': `attachment; filename="${pdf ? 'page.pdf' : 'screenshot.png'}"`,
                    },
                });
            }),
    };
}
