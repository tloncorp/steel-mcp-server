// ABOUTME: Integration tests for the MCP Apps surface: the ui:// session-viewer resource, the
// ABOUTME: the single resourceUri on session_create, and the app-only live-view tool's authorization and secrecy.
import { Client } from '@modelcontextprotocol/client';
import {
    CLIENT_CAPABILITIES_META_KEY,
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
    SESSION_VIEWER_HTML,
    SESSION_VIEWER_MIME_TYPE,
    SESSION_VIEWER_URI,
} from '../../src/core/apps/session-viewer.js';
import { InMemoryHandleRegistry, principalFromCredential } from '../../src/core/registry.js';
import { createSteelMcpServer, UI_EXTENSION_NAME } from '../../src/core/server.js';
import { createSteelHttpHandler } from '../../src/http.js';
import { FAKE_VIEWPORT, FakeSteelApi, TEST_API_KEY, testDeps } from '../helpers/fakes.js';
import { tracingHarness } from '../helpers/tracing.js';

type Deps = ReturnType<typeof testDeps>;

interface Harness {
    client: Client;
    deps: Deps;
    close(): Promise<void>;
}

const open: Harness[] = [];

async function connect(deps: Deps = testDeps()): Promise<Harness> {
    const server = createSteelMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const harness: Harness = {
        client,
        deps,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
    open.push(harness);
    return harness;
}

afterEach(async () => {
    while (open.length) await open.pop()?.close();
});

function textOf(result: unknown): string {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    return content
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n');
}

function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
}

async function newSession(harness: Harness): Promise<string> {
    const result = await harness.client.callTool({ name: 'browser_session_create', arguments: {} });
    const structured = (result as { structuredContent?: { session_id?: string } }).structuredContent;
    if (!structured?.session_id) throw new Error(`session_create failed: ${textOf(result)}`);
    return structured.session_id;
}

interface LiveView {
    session_id?: string;
    cdp_url?: string;
    viewport?: { width: number; height: number };
    expires_at?: string;
    control?: { state?: string; token?: string; lease_expires_at?: string };
}

async function liveView(harness: Harness, sessionId?: string) {
    const result = await harness.client.callTool({
        name: 'browser_session_live_view',
        arguments: sessionId === undefined ? {} : { session_id: sessionId },
    });
    return { result, structured: (result as { structuredContent?: LiveView }).structuredContent };
}

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const RETIRED_SESSION_REPLAY_URI = 'ui://steel/session-replay';

/**
 * Answers one request on the 2026-07-28 era, through the hosted HTTP boundary.
 *
 * The in-memory transport pair negotiates the legacy era, and only the modern encode seam fills the
 * `ttlMs`/`cacheScope` fields a cache hint ends up in — so the hints have to be read over here.
 */
async function modernResult(method: string, params: Record<string, unknown> = {}) {
    const handler = createSteelHttpHandler({
        allowedHostnames: ['mcp.steel.dev'],
        allowedOriginHostnames: ['steel.dev'],
        depsForRequest: () => testDeps(),
    });
    const headers: Record<string, string> = {
        host: 'mcp.steel.dev',
        authorization: `Bearer ${TEST_API_KEY}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
        'mcp-method': method,
    };
    // SEP-2243: a request naming a target in its body has to mirror that name in a header.
    if (typeof params.uri === 'string') headers['mcp-name'] = params.uri;

    try {
        const response = await handler.fetch(
            new Request('https://mcp.steel.dev/mcp', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method,
                    params: {
                        ...params,
                        _meta: {
                            [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
                            [CLIENT_CAPABILITIES_META_KEY]: {},
                        },
                    },
                }),
            })
        );
        const body = (await response.json()) as { result?: { ttlMs?: number; cacheScope?: string } };
        if (!body.result) throw new Error(`${method} failed: ${JSON.stringify(body)}`);
        return body.result;
    } finally {
        await handler.close();
    }
}

/** The `_meta.ui` block a host reads, whether it comes off a list entry or a content item. */
interface UiMeta {
    resourceUri?: string;
    visibility?: string[];
    prefersBorder?: boolean;
    csp?: { connectDomains?: string[]; resourceDomains?: string[] };
}

function uiMetaOf(carrier: unknown): UiMeta | undefined {
    return (carrier as { _meta?: { ui?: UiMeta } } | undefined)?._meta?.ui;
}

describe('the MCP Apps capability', () => {
    it('is advertised so a supporting host knows the ui:// resource is renderable', async () => {
        const harness = await connect();
        const capabilities = harness.client.getServerCapabilities();
        expect(capabilities?.extensions?.[UI_EXTENSION_NAME]).toEqual({});
    });

    it('comes with the resources capability the ui:// resource is served over', async () => {
        const harness = await connect();
        expect(harness.client.getServerCapabilities()?.resources).toBeDefined();
    });
});

describe('the session-viewer resource', () => {
    it('is listed under its ui:// URI with the app MIME type and the host hints', async () => {
        const harness = await connect();
        const { resources } = await harness.client.listResources();
        const entry = resources.find(resource => resource.uri === SESSION_VIEWER_URI);
        expect(entry?.mimeType).toBe(SESSION_VIEWER_MIME_TYPE);
        expect(uiMetaOf(entry)?.prefersBorder).toBe(true);
    });

    it('serves the shell with the app MIME type and the authoritative _meta.ui on the content item', async () => {
        const harness = await connect();
        const result = await harness.client.readResource({ uri: SESSION_VIEWER_URI });
        const [content] = result.contents;
        expect(content).toMatchObject({
            uri: SESSION_VIEWER_URI,
            mimeType: SESSION_VIEWER_MIME_TYPE,
            text: SESSION_VIEWER_HTML,
        });
        expect(uiMetaOf(content)?.prefersBorder).toBe(true);
    });

    it('declares the CDP origin the shell has to reach, derived from the configured connect URL', async () => {
        const harness = await connect();
        const result = await harness.client.readResource({ uri: SESSION_VIEWER_URI });
        expect(uiMetaOf(result.contents[0])?.csp?.connectDomains).toEqual(['wss://connect.steel.dev']);
    });

    it('declares a self-hosted deployment its own connect origin rather than Steel Cloud', async () => {
        const harness = await connect(
            testDeps({
                env: {
                    STEEL_BASE_URL: 'http://steel.internal:3000',
                    STEEL_CONNECT_URL: 'wss://cdp.internal:8443/devtools',
                },
            })
        );
        const result = await harness.client.readResource({ uri: SESSION_VIEWER_URI });
        expect(uiMetaOf(result.contents[0])?.csp?.connectDomains).toEqual(['wss://cdp.internal:8443']);
    });

    it('is cached publicly for an hour, overriding the private no-store hint on resources/read', async () => {
        // The server-level `resources/read` hint is ttlMs 0 / private, because anything derived from
        // an authenticated principal must never reach a shared cache. This shell is derived from
        // neither a principal nor a session, and the per-resource hint wins field by field.
        const result = await modernResult('resources/read', { uri: SESSION_VIEWER_URI });
        expect(result.ttlMs).toBe(3_600_000);
        expect(result.cacheScope).toBe('public');
    });

    it('leaves the resource list itself on the server-level private hint', async () => {
        const result = await modernResult('resources/list');
        expect(result.ttlMs).toBe(0);
        expect(result.cacheScope).toBe('private');
    });
});

describe('the retired session-replay resource', () => {
    it('is absent from resources/list while the dashboard-only tool remains available', async () => {
        const harness = await connect();
        const { resources } = await harness.client.listResources();
        const { tools } = await harness.client.listTools();

        expect(resources.map(resource => resource.uri)).not.toContain(RETIRED_SESSION_REPLAY_URI);
        expect(tools.map(tool => tool.name)).toContain('browser_session_replay');
    });

    it('returns not-found when an old host reads the retired URI', async () => {
        const harness = await connect();
        await expect(harness.client.readResource({ uri: RETIRED_SESSION_REPLAY_URI })).rejects.toThrow(/not found/i);
    });
});

describe('browser_session_create', () => {
    it('is the only tool that points a supporting host at the session viewer', async () => {
        const harness = await connect();
        const { tools } = await harness.client.listTools();
        const viewerTools = tools
            .filter(tool => uiMetaOf(tool)?.resourceUri === SESSION_VIEWER_URI)
            .map(tool => tool.name);
        expect(viewerTools).toEqual(['browser_session_create']);
    });

    it('returns exactly what it always did', async () => {
        const harness = await connect();
        const result = await harness.client.callTool({ name: 'browser_session_create', arguments: {} });
        expect(textOf(result)).toContain('Started a browser session.');
        expect(textOf(result)).toContain('Pass session_id="sess_');
    });
});

describe('browser_session_live_view', () => {
    it('is listed, marked app-only, so a host filters it out of the agent’s tool list', async () => {
        const harness = await connect();
        const { tools } = await harness.client.listTools();
        const liveViewTool = tools.find(tool => tool.name === 'browser_session_live_view');
        expect(uiMetaOf(liveViewTool)?.visibility).toEqual(['app']);
    });

    it('returns the scoped CDP URL, the viewport and the expiry, and only in structuredContent', async () => {
        const harness = await connect();
        const sessionId = await newSession(harness);
        const { result, structured } = await liveView(harness, sessionId);

        expect(isError(result)).toBe(false);
        expect(structured?.cdp_url).toMatch(/^wss:\/\/connect\.steel\.dev\/\?sessionId=.+&token=jwt-1$/);
        expect(structured?.viewport).toEqual(FAKE_VIEWPORT);
        expect(structured?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        // The URL drives the browser. The model reads `content`; only the app reads structured data.
        expect(textOf(result)).not.toContain('token=');
        expect(textOf(result)).not.toContain('wss://');
        expect(textOf(result)).toContain('Live view connection details for this session.');
    });

    // The host pushes the tool result to the app once, when the call completes, and the spec has no
    // replay and no way to ask for it again. An app that finished initialising after that instant
    // never learns its session id — measured in Claude Desktop, where the viewer rendered while the
    // create call was still running and then sat on "waiting for a browser session" for ever.
    it('resolves the caller’s own live session when the host never pushed one', async () => {
        const harness = await connect();
        const sessionId = await newSession(harness);

        const { result, structured } = await liveView(harness);

        expect(isError(result)).toBe(false);
        expect(structured?.cdp_url).toContain(sessionId ? 'sessionId=' : '');
        expect(structured?.session_id).toBe(sessionId);
    });

    it('picks the newest live session when the caller has more than one', async () => {
        const harness = await connect();
        await newSession(harness);
        // Both handles are stamped from the real clock, so they need distinct milliseconds: which of
        // two sessions created in the same millisecond is "newest" is not a question with an answer.
        await new Promise(resolve => setTimeout(resolve, 2));
        const newest = await newSession(harness);

        const { structured } = await liveView(harness);

        expect(structured?.session_id).toBe(newest);
    });

    it('never resolves to a session belonging to another credential', async () => {
        const registry = new InMemoryHandleRegistry({ releaseSteelSession: async () => undefined });
        const owner = await connect(testDeps({ registry }));
        const stranger = await connect({
            ...testDeps({ registry }),
            principal: principalFromCredential('ste-someone-else'),
        });
        await newSession(owner);

        const { result, structured } = await liveView(stranger);

        expect(isError(result)).toBe(true);
        expect(structured).not.toHaveProperty('cdp_url');
        expect(stranger.deps.api.sessionReads).toHaveLength(0);
    });

    it('says plainly that there is nothing to show when the caller has no live session', async () => {
        const harness = await connect();

        const { result } = await liveView(harness);

        expect(isError(result)).toBe(true);
        expect(textOf(result)).toContain('no live browser session');
    });

    it('omits the viewport rather than inventing one when Steel reports no dimensions', async () => {
        const harness = await connect(testDeps({ api: new FakeSteelApi({ dimensions: null }) }));
        const sessionId = await newSession(harness);
        const { structured } = await liveView(harness, sessionId);
        expect(structured?.cdp_url).toBeDefined();
        expect(structured).not.toHaveProperty('viewport');
    });

    it('fetches the URL from Steel on every call, because the token is re-minted each read', async () => {
        const harness = await connect();
        const sessionId = await newSession(harness);
        const first = await liveView(harness, sessionId);
        const second = await liveView(harness, sessionId);

        expect(harness.deps.api.sessionReads).toHaveLength(2);
        expect(second.structured?.cdp_url).not.toBe(first.structured?.cdp_url);
    });

    it('never persists the credential on the handle record', async () => {
        const harness = await connect();
        const sessionId = await newSession(harness);
        await liveView(harness, sessionId);
        const [record] = await harness.deps.registry.list(harness.deps.principal);
        expect(JSON.stringify(record)).not.toContain('token=');
    });

    it('refuses a handle belonging to another credential, exactly like every other stateful tool', async () => {
        const registry = new InMemoryHandleRegistry({ releaseSteelSession: async () => undefined });
        const owner = await connect(testDeps({ registry }));
        const stranger = await connect({
            ...testDeps({ registry }),
            principal: principalFromCredential('ste-someone-else'),
        });

        const sessionId = await newSession(owner);
        const { result, structured } = await liveView(stranger, sessionId);

        expect(isError(result)).toBe(true);
        expect(textOf(result)).toContain('may belong to a different credential');
        expect(structured).not.toHaveProperty('cdp_url');
        // Rejected before any Steel call, so there is no minted token to leak in the first place.
        expect(stranger.deps.api.sessionReads).toHaveLength(0);
    });

    it('reports a deployment that returns no CDP URL instead of building one from the API key', async () => {
        const harness = await connect(testDeps({ api: new FakeSteelApi({ websocketUrl: null }) }));
        const sessionId = await newSession(harness);
        const { result } = await liveView(harness, sessionId);

        expect(isError(result)).toBe(true);
        expect(textOf(result)).toContain('no live-view connection');
        // The fallback URL would carry STEEL_API_KEY, which must never reach the app or the model.
        expect(textOf(result)).not.toContain('apiKey');
    });

    it('keeps the URL out of a failing call’s error text', async () => {
        const failure = new Error('read failed for wss://connect.steel.dev/?sessionId=x&token=leaked');
        const harness = await connect(testDeps({ api: new FakeSteelApi({ failGetSessionWith: failure }) }));
        const sessionId = await newSession(harness);
        const { result } = await liveView(harness, sessionId);

        expect(isError(result)).toBe(true);
        expect(textOf(result)).not.toContain('token=leaked');
        expect(textOf(result)).toContain('Could not read the live-view connection details');
    });

    it('records no CDP URL on its span', async () => {
        const tracing = tracingHarness();
        const harness = await connect(testDeps({ tracer: tracing.tracer }));
        const sessionId = await newSession(harness);
        await liveView(harness, sessionId);

        const span = tracing.span('tools/call browser_session_live_view');
        expect(JSON.stringify(span.attributes)).not.toContain('token=');
        await tracing.shutdown();
    });

    it('acquires, renews and releases exclusive human control without exposing the token in text', async () => {
        const harness = await connect();
        const sessionId = await newSession(harness);
        const acquire = await harness.client.callTool({
            name: 'browser_session_live_view',
            arguments: { session_id: sessionId, action: 'acquire' },
        });
        const control = (acquire as { structuredContent?: LiveView }).structuredContent?.control;
        expect(control?.state).toBe('human');
        expect(control?.token).toMatch(/^ctl_/);
        expect(textOf(acquire)).not.toContain(control?.token ?? 'ctl_');

        const blocked = await harness.client.callTool({
            name: 'browser_snapshot',
            arguments: { session_id: sessionId },
        });
        expect(isError(blocked)).toBe(true);
        expect((blocked as { structuredContent?: { error?: { code?: string } } }).structuredContent?.error?.code).toBe(
            'human_control_active'
        );

        const renew = await harness.client.callTool({
            name: 'browser_session_live_view',
            arguments: { session_id: sessionId, action: 'renew', control_token: control?.token },
        });
        expect((renew as { structuredContent?: LiveView }).structuredContent?.control?.token).toBe(control?.token);

        const released = await harness.client.callTool({
            name: 'browser_session_live_view',
            arguments: { session_id: sessionId, action: 'release', control_token: control?.token },
        });
        expect((released as { structuredContent?: LiveView }).structuredContent?.control?.state).toBe('agent');
        expect(isError(released)).toBe(false);
    });

    it('allows only the viewer holding the current fencing token to hand control back', async () => {
        const harness = await connect();
        const sessionId = await newSession(harness);
        await harness.client.callTool({
            name: 'browser_session_live_view',
            arguments: { session_id: sessionId, action: 'acquire' },
        });
        const release = await harness.client.callTool({
            name: 'browser_session_live_view',
            arguments: { session_id: sessionId, action: 'release', control_token: 'ctl_stale' },
        });
        expect(isError(release)).toBe(true);
        expect((release as { structuredContent?: { error?: { code?: string } } }).structuredContent?.error?.code).toBe(
            'human_control_active'
        );
    });
});
