// ABOUTME: Integration tests for the hosted fetch boundary: routing, DNS-rebinding guards, auth
// ABOUTME: precedence, per-credential request budgets and isolation into per-credential server deps.
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { SteelToolError } from '../../src/core/errors.js';
import { InMemoryRateLimiter, RATE_LIMIT_NAME, type RateLimitPolicy } from '../../src/core/rate-limit.js';
import { principalFromCredential } from '../../src/core/registry.js';
import type { CreateSessionRequest, SteelSession } from '../../src/core/steel/types.js';
import { createHandleRegistryBackend, HostedRuntime } from '../../src/hosted-runtime.js';
import { createSteelHttpHandler, type RequestDepsInput } from '../../src/http.js';
import { FakeRedis } from '../helpers/fake-redis.js';
import { FakeSteelApi, testDeps } from '../helpers/fakes.js';
import { tracingHarness } from '../helpers/tracing.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

function modernRequest(
    url = 'https://mcp.steel.dev/mcp',
    options: { authorization?: string; xApiKey?: string; host?: string; origin?: string; method?: string } = {}
): Request {
    const method = options.method ?? 'POST';
    const headers = new Headers({
        host: options.host ?? 'mcp.steel.dev',
        accept: 'application/json',
    });
    if (options.authorization !== undefined) headers.set('authorization', options.authorization);
    if (options.xApiKey !== undefined) headers.set('x-api-key', options.xApiKey);
    if (options.origin !== undefined) headers.set('origin', options.origin);
    if (method === 'POST') {
        headers.set('content-type', 'application/json');
        headers.set('mcp-protocol-version', MODERN_PROTOCOL_VERSION);
        headers.set('mcp-method', 'server/discover');
    }

    return new Request(url, {
        method,
        headers,
        body:
            method === 'POST'
                ? JSON.stringify({
                      jsonrpc: '2.0',
                      id: 1,
                      method: 'server/discover',
                      params: {
                          _meta: {
                              [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
                              [CLIENT_CAPABILITIES_META_KEY]: {},
                          },
                      },
                  })
                : undefined,
    });
}

function toolRequest(credential: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Request {
    return new Request('https://mcp.steel.dev/mcp', {
        method: 'POST',
        headers: {
            host: 'mcp.steel.dev',
            authorization: `Bearer ${credential}`,
            accept: 'application/json',
            'content-type': 'application/json',
            'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
            'mcp-method': 'tools/call',
            'mcp-name': name,
        },
        signal,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name,
                arguments: args,
                _meta: {
                    [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
                    [CLIENT_CAPABILITIES_META_KEY]: {},
                },
            },
        }),
    });
}

function harness() {
    const seen: RequestDepsInput[] = [];
    const handler = createSteelHttpHandler({
        allowedHostnames: ['mcp.steel.dev'],
        allowedOriginHostnames: ['steel.dev'],
        depsForRequest: input => {
            seen.push(input);
            const deps = testDeps();
            deps.principal = input.principal;
            deps.config = { ...deps.config, apiKey: input.credential };
            return deps;
        },
    });
    return { handler, seen };
}

const openHandlers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
    await Promise.all(openHandlers.splice(0).map(handler => handler.close()));
});

describe('hosted HTTP authentication', () => {
    it('attributes each request without treating its ship label as tenant identity', async () => {
        const tracing = tracingHarness();
        const deps = testDeps({ tracer: tracing.tracer });
        const handler = createSteelHttpHandler({
            allowedHostnames: ['mcp.steel.dev'],
            allowedOriginHostnames: [],
            depsForRequest: () => deps,
        });
        openHandlers.push(handler);
        try {
            for (const ship of ['~fildes-magwes', '~binbud-namhet', 'not a ship']) {
                const request = toolRequest('same-credential', 'browser_scrape', { url: 'https://example.com' });
                request.headers.set('X-Tlon-Ship', ship);
                expect((await handler.fetch(request)).status).toBe(200);
            }
            const calls = tracing.spans().filter(span => span.name === 'tools/call browser_scrape');
            expect(calls.map(span => span.attributes['tlon.ship'])).toEqual([
                '~fildes-magwes',
                '~binbud-namhet',
                undefined,
            ]);
            expect(calls.map(span => span.attributes['steel.principal'])).toEqual(
                Array(3).fill(principalFromCredential('same-credential'))
            );
        } finally {
            await tracing.shutdown();
        }
    });

    it('records admission rejections as failed tool calls without recording error prose', async () => {
        const tracing = tracingHarness();
        const deps = testDeps({ tracer: tracing.tracer });
        deps.limiter = {
            charge: async () => {
                throw new SteelToolError('SECRET', { code: 'rate_limited' });
            },
        };
        const handler = createSteelHttpHandler({
            allowedHostnames: ['mcp.steel.dev'],
            allowedOriginHostnames: [],
            depsForRequest: () => deps,
        });
        openHandlers.push(handler);
        try {
            await handler.fetch(toolRequest('credential', 'browser_scrape', { url: 'https://example.com' }));
            const span = tracing.span('tools/call browser_scrape');
            expect(span.status.code).toBe(SpanStatusCode.ERROR);
            expect(span.attributes['error.type']).toBe('rate_limited');
            expect(JSON.stringify(span.attributes)).not.toContain('SECRET');
            expect(span.events).toEqual([]);
        } finally {
            await tracing.shutdown();
        }
    });

    it('uses the bearer credential and derives a non-secret principal for the request', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(modernRequest(undefined, { authorization: 'Bearer ste-header' }));

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.credential).toBe('ste-header');
        expect(seen[0]?.principal).toMatch(/^[a-f0-9]{32}$/);
        expect(seen[0]?.principal).not.toContain('ste-header');
        expect(seen[0]?.request.headers.get('authorization')).toBeNull();
    });

    it('accepts apiKey as a fallback, while a valid bearer header takes precedence', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        await handler.fetch(
            modernRequest('https://mcp.steel.dev/mcp?apiKey=ste-query', {
                authorization: 'Bearer ste-header',
            })
        );
        await handler.fetch(modernRequest('https://mcp.steel.dev/mcp?apiKey=ste-query-only'));

        expect(seen.map(input => input.credential)).toEqual(['ste-header', 'ste-query-only']);
        expect(seen[1]?.request.url).not.toContain('apiKey');
    });

    it('accepts X-Api-Key as a tenant credential and redacts it before constructing dependencies', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(modernRequest(undefined, { xApiKey: 'moon-secret' }));

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.credential).toBe('moon-secret');
        expect(seen[0]?.principal).toBe(principalFromCredential('moon-secret'));
        expect(seen[0]?.request.headers.get('x-api-key')).toBeNull();
    });

    it('keeps Bearer authoritative when both supported credential headers are present', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        await handler.fetch(
            modernRequest(undefined, { authorization: 'Bearer bearer-secret', xApiKey: 'moon-secret' })
        );

        expect(seen.map(input => input.credential)).toEqual(['bearer-secret']);
    });

    it('does not downgrade a malformed Authorization header to a query credential', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(
            modernRequest('https://mcp.steel.dev/mcp?apiKey=ste-query', { authorization: 'Basic abc' })
        );

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
        expect(seen).toHaveLength(0);
    });

    it('challenges a request with no credential before constructing server dependencies', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(modernRequest());

        expect(response.status).toBe(401);
        expect(seen).toHaveLength(0);
    });
});

describe('hosted HTTP routing guards', () => {
    it('rejects an untrusted Host or browser Origin before authentication', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const badHost = await handler.fetch(
            modernRequest(undefined, { host: 'attacker.test', authorization: 'Bearer ste-secret' })
        );
        const badOrigin = await handler.fetch(
            modernRequest(undefined, {
                origin: 'https://attacker.test',
                authorization: 'Bearer ste-secret',
            })
        );

        expect(badHost.status).toBe(403);
        expect(badOrigin.status).toBe(403);
        expect(seen).toHaveLength(0);
    });

    it.each(['GET', 'DELETE'])('answers %s on /mcp with 405 and never constructs dependencies', async method => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(modernRequest(undefined, { method }));

        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST');
        expect(seen).toHaveLength(0);
    });

    it('does not serve the MCP handler on another path', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(
            modernRequest('https://mcp.steel.dev/not-mcp', { authorization: 'Bearer ste-secret' })
        );

        expect(response.status).toBe(404);
        expect(seen).toHaveLength(0);
    });
});

describe('hosted HTTP rate limiting', () => {
    /** Four units of burst keeps the wire test short; the shipped policy is ten times larger. */
    const SMALL_POLICY: RateLimitPolicy = { refillPerMinute: 60, burstCapacity: 4 };

    function limitedHarness() {
        const api = new FakeSteelApi();
        let ms = 1_800_000_000_000;
        const runtime = new HostedRuntime({
            configForCredential: credential => loadConfig({ STEEL_API_KEY: credential }),
            createApi: () => api,
            createPool: () => testDeps().pool,
            now: () => new Date(ms),
            createLimiter: now => new InMemoryRateLimiter({ policy: SMALL_POLICY, now }),
        });
        const handler = createSteelHttpHandler({
            allowedHostnames: ['mcp.steel.dev'],
            allowedOriginHostnames: ['steel.dev'],
            depsForRequest: runtime.depsForRequest,
        });
        openHandlers.push({
            close: async () => {
                await handler.close();
                await runtime.close();
            },
        });
        return {
            handler,
            api,
            advanceSeconds: (seconds: number) => {
                ms += seconds * 1_000;
            },
        };
    }

    async function callScrape(handler: { fetch(request: Request): Promise<Response> }, credential: string) {
        const response = await handler.fetch(
            toolRequest(credential, 'browser_scrape', { url: 'https://example.com/' })
        );
        const body = (await response.json()) as {
            result: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown };
        };
        return {
            isError: body.result.isError === true,
            text: body.result.content?.map(block => block.text ?? '').join('\n') ?? '',
            structured: body.result.structuredContent,
        };
    }

    it('rejects a call over budget with an error naming the limit and a retry-after', async () => {
        const { handler, api, advanceSeconds } = limitedHarness();

        for (let call = 0; call < SMALL_POLICY.burstCapacity; call++) {
            expect((await callScrape(handler, 'ste-noisy')).isError).toBe(false);
        }
        const scrapesBefore = api.scrapes.length;
        const rejected = await callScrape(handler, 'ste-noisy');

        expect(rejected.isError).toBe(true);
        expect(rejected.text).toContain(RATE_LIMIT_NAME);
        expect(rejected.text).toContain('browser_scrape');
        expect(rejected.text).toMatch(/Retry after \d+s/);
        expect(rejected.text).toMatch(/Retry-After: \d+s/);
        expect(rejected.structured).toMatchObject({ error: { code: 'rate_limited' } });
        // Admission control runs before the handler, so nothing reached Steel.
        expect(api.scrapes).toHaveLength(scrapesBefore);

        advanceSeconds(1);
        expect((await callScrape(handler, 'ste-noisy')).isError).toBe(false);
    });

    it('never lets one credential spend the budget of another', async () => {
        const { handler } = limitedHarness();

        for (let call = 0; call < SMALL_POLICY.burstCapacity; call++) await callScrape(handler, 'ste-noisy');
        expect((await callScrape(handler, 'ste-noisy')).isError).toBe(true);

        expect((await callScrape(handler, 'ste-quiet')).isError).toBe(false);
    });
});

describe('hosted HTTP session isolation', () => {
    it('keeps a handle across requests for its owner and rejects the same handle from another credential', async () => {
        const runtime = new HostedRuntime({
            configForCredential: credential => loadConfig({ STEEL_API_KEY: credential }),
            createApi: () => new FakeSteelApi(),
            createPool: () => testDeps().pool,
        });
        const handler = createSteelHttpHandler({
            allowedHostnames: ['mcp.steel.dev'],
            allowedOriginHostnames: ['steel.dev'],
            depsForRequest: runtime.depsForRequest,
        });
        openHandlers.push({
            close: async () => {
                await handler.close();
                await runtime.close();
            },
        });

        const createdResponse = await handler.fetch(toolRequest('ste-owner', 'browser_session_create', {}));
        const created = (await createdResponse.json()) as {
            result: { structuredContent?: { session_id?: string } };
        };
        const sessionId = created.result.structuredContent?.session_id;
        expect(sessionId).toMatch(/^sess_/);

        const ownerResponse = await handler.fetch(
            toolRequest('ste-owner', 'browser_session_diagnostics', { session_id: sessionId })
        );
        const owner = (await ownerResponse.json()) as { result: { isError?: boolean } };
        expect(owner.result.isError).not.toBe(true);

        const strangerResponse = await handler.fetch(
            toolRequest('ste-stranger', 'browser_session_diagnostics', { session_id: sessionId })
        );
        const stranger = (await strangerResponse.json()) as {
            result: { isError?: boolean; content?: Array<{ text?: string }> };
        };
        expect(stranger.result.isError).toBe(true);
        expect(stranger.result.content?.map(block => block.text).join('\n')).toMatch(
            /MCP session handle.*session dashboard/i
        );

        const releaseResponse = await handler.fetch(
            toolRequest('ste-owner', 'browser_session_release', { session_id: sessionId })
        );
        expect(releaseResponse.status).toBe(200);
    });

    it('authorizes a dashboard replay UUID per credential without reading private HLS data', async () => {
        const replayId = '33333333-3333-4333-8333-333333333333';
        const privateUpstreamMarker = 'session belongs to private tenant org-456';
        const ownerApi = new FakeSteelApi({
            sessionsById: {
                [replayId]: {
                    id: replayId,
                    status: 'released',
                    headless: false,
                    sessionViewerUrl: `https://app.steel.dev/sessions/${replayId}`,
                },
            },
            hlsBySession: { [replayId]: '#EXTM3U\n#EXT-X-ENDLIST' },
        });
        const strangerApi = new FakeSteelApi({
            sessionsById: {
                [replayId]: new SteelToolError(privateUpstreamMarker, { code: 'forbidden' }),
            },
        });
        const runtime = new HostedRuntime({
            configForCredential: credential => loadConfig({ STEEL_API_KEY: credential }),
            createApi: config => {
                if (config.apiKey === 'ste-replay-owner') return ownerApi;
                if (config.apiKey === 'ste-replay-stranger') return strangerApi;
                throw new Error('Unexpected test credential.');
            },
            createPool: () => testDeps().pool,
        });
        const handler = createSteelHttpHandler({
            allowedHostnames: ['mcp.steel.dev'],
            allowedOriginHostnames: ['steel.dev'],
            depsForRequest: runtime.depsForRequest,
        });
        openHandlers.push({
            close: async () => {
                await handler.close();
                await runtime.close();
            },
        });

        const ownerResponse = await handler.fetch(
            toolRequest('ste-replay-owner', 'browser_session_replay', { finished_session_id: replayId })
        );
        const owner = (await ownerResponse.json()) as { result: { isError?: boolean; structuredContent?: unknown } };
        expect(ownerResponse.status).toBe(200);
        expect(owner.result.isError).not.toBe(true);
        expect(ownerApi.sessionReads).toEqual([replayId]);
        expect(ownerApi.hlsReads).toEqual([]);
        expect(JSON.stringify(owner.result.structuredContent)).not.toMatch(/manifest|kind.*hls|steel\/replay/i);

        const strangerResponse = await handler.fetch(
            toolRequest('ste-replay-stranger', 'browser_session_replay', { finished_session_id: replayId })
        );
        const stranger = (await strangerResponse.json()) as {
            result: {
                isError?: boolean;
                content?: Array<{ text?: string }>;
                structuredContent?: { error?: { code?: string } };
            };
        };
        const strangerVisible = JSON.stringify({
            content: stranger.result.content,
            structuredContent: stranger.result.structuredContent,
        });

        expect(strangerResponse.status).toBe(200);
        expect(stranger.result.isError).toBe(true);
        expect(stranger.result.structuredContent?.error?.code).toBe('not_found');
        expect(strangerVisible).toMatch(/No browser session with that UUID was found for this credential/i);
        expect(strangerVisible).not.toContain(privateUpstreamMarker);
        expect(strangerVisible).not.toContain('#EXTM3U');
        expect(strangerApi.sessionReads).toEqual([replayId]);
        expect(strangerApi.hlsReads).toEqual([]);
    });

    it('serves a handle from a replica that did not create it, with no sticky routing', async () => {
        // Two replicas behind round-robin, sharing one handle store: the second request lands
        // somewhere else and must still find the session, then release it through its own client.
        const store = new FakeRedis();
        const backend = createHandleRegistryBackend({
            env: { REDIS_URL: 'redis://cache:6379', STEEL_REQUEST_STATE_SECRET: 'x'.repeat(48) },
            connect: () => ({ commands: store, close: async () => {} }),
            onError: error => {
                throw error;
            },
        });

        function replica() {
            const api = new FakeSteelApi();
            const runtime = new HostedRuntime({
                configForCredential: credential => loadConfig({ STEEL_API_KEY: credential }),
                createApi: () => api,
                createPool: () => testDeps().pool,
                createRegistry: backend.createRegistry,
            });
            const handler = createSteelHttpHandler({
                allowedHostnames: ['mcp.steel.dev'],
                allowedOriginHostnames: ['steel.dev'],
                depsForRequest: runtime.depsForRequest,
            });
            openHandlers.push({
                close: async () => {
                    await handler.close();
                    await runtime.close();
                },
            });
            return { api, runtime, handler };
        }

        const first = replica();
        const second = replica();

        const createdResponse = await first.handler.fetch(toolRequest('ste-a', 'browser_session_create', {}));
        const created = (await createdResponse.json()) as { result: { structuredContent?: { session_id?: string } } };
        const sessionId = created.result.structuredContent?.session_id;
        expect(sessionId).toMatch(/^sess_/);
        expect(first.api.created).toHaveLength(1);

        const elsewhere = await second.handler.fetch(
            toolRequest('ste-a', 'browser_session_diagnostics', { session_id: sessionId })
        );
        const diagnostics = (await elsewhere.json()) as { result: { isError?: boolean } };
        expect(diagnostics.result.isError, 'the second replica could not see the handle').not.toBe(true);

        const releaseResponse = await second.handler.fetch(
            toolRequest('ste-a', 'browser_session_release', { session_id: sessionId })
        );
        expect(releaseResponse.status).toBe(200);
        expect(second.api.released).toEqual([first.api.created[0]?.sessionId]);
        expect(first.api.released, 'the creating replica released it as well').toEqual([]);
        expect(await first.runtime.registry.countLive(principalFromCredential('ste-a'))).toBe(0);

        await backend.close();
    });

    it('releases a session when the creating HTTP request disconnects after Steel accepted it', async () => {
        const controller = new AbortController();
        class AbortAfterCreateApi extends FakeSteelApi {
            override async createSession(request: CreateSessionRequest): Promise<SteelSession> {
                const session = await super.createSession(request);
                controller.abort();
                return session;
            }
        }

        const api = new AbortAfterCreateApi();
        const runtime = new HostedRuntime({
            configForCredential: credential => loadConfig({ STEEL_API_KEY: credential }),
            createApi: () => api,
            createPool: () => testDeps().pool,
        });
        const handler = createSteelHttpHandler({
            allowedHostnames: ['mcp.steel.dev'],
            allowedOriginHostnames: ['steel.dev'],
            depsForRequest: runtime.depsForRequest,
        });
        openHandlers.push({
            close: async () => {
                await handler.close();
                await runtime.close();
            },
        });

        await handler.fetch(toolRequest('ste-disconnected', 'browser_session_create', {}, controller.signal));

        expect(api.created).toHaveLength(1);
        await expect.poll(() => api.released, { timeout: 1_000 }).toEqual([api.created[0]?.sessionId]);
        await expect
            .poll(() => runtime.registry.countLive(principalFromCredential('ste-disconnected')), { timeout: 1_000 })
            .toBe(0);
        expect(runtime.registry.releaseCounts().stream_close).toBe(1);
    });
});
