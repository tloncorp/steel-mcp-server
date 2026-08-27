// ABOUTME: Unit tests for the typed Steel REST layer, pinning the parameter names and response
// ABOUTME: shapes that the published SDK gets wrong, with a fake fetch injected at the boundary.
import { SpanKind, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { SteelToolError } from '../../src/core/errors.js';
import { SteelRestClient } from '../../src/core/steel/rest.js';
import { tracingHarness } from '../helpers/tracing.js';

interface RecordedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

function fakeFetch(
    responses: Array<{ status?: number; body?: unknown; rawBody?: string; headers?: Record<string, string> }>
) {
    const calls: RecordedCall[] = [];
    let index = 0;
    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        calls.push({
            url: String(input),
            method: init?.method ?? 'GET',
            headers,
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        const spec = responses[Math.min(index++, responses.length - 1)] ?? {};
        return new Response(spec.rawBody ?? JSON.stringify(spec.body ?? {}), {
            status: spec.status ?? 200,
            headers: {
                'content-type': spec.rawBody === undefined ? 'application/json' : 'application/vnd.apple.mpegurl',
                ...(spec.headers ?? {}),
            },
        });
    };
    return { calls, fetchImpl };
}

function client(
    responses: Parameters<typeof fakeFetch>[0],
    env: Record<string, string | undefined> = { STEEL_API_KEY: 'ste-secret' },
    tracer?: Tracer
) {
    const { calls, fetchImpl } = fakeFetch(responses);
    return { calls, api: new SteelRestClient(loadConfig(env), fetchImpl, tracer) };
}

/** Awaits a rejection and returns it typed, so assertions do not fight the success-type union. */
async function captureError(promise: Promise<unknown>): Promise<SteelToolError> {
    try {
        await promise;
    } catch (error) {
        return error as SteelToolError;
    }
    throw new Error('Expected the promise to reject, but it resolved.');
}

describe('SteelRestClient.scrape', () => {
    it('sends the singular format parameter with an array value', async () => {
        const { api, calls } = client([{ body: { content: { markdown: '# hi' }, links: [], metadata: {} } }]);
        await api.scrape({ url: 'https://example.com', format: ['markdown', 'html'] });
        expect(calls[0]!.url).toBe('https://api.steel.dev/v1/scrape');
        expect(calls[0]!.method).toBe('POST');
        expect(calls[0]!.body).toMatchObject({ url: 'https://example.com', format: ['markdown', 'html'] });
        expect(calls[0]!.body).not.toHaveProperty('formats');
    });

    it('never sends links as a format value because links are always returned', async () => {
        const { api, calls } = client([
            { body: { content: { markdown: 'x' }, links: [{ url: 'https://a', text: 'A' }], metadata: {} } },
        ]);
        const result = await api.scrape({ url: 'https://example.com', format: ['markdown'] });
        expect((calls[0]!.body as { format: string[] }).format).not.toContain('links');
        expect(result.links).toEqual([{ url: 'https://a', text: 'A' }]);
    });

    it('authenticates with a bearer token', async () => {
        const { api, calls } = client([{ body: { content: {}, links: [], metadata: {} } }]);
        await api.scrape({ url: 'https://example.com', format: ['markdown'] });
        expect(calls[0]!.headers.authorization).toBe('Bearer ste-secret');
    });

    it('sends no credential to a self-hosted deployment', async () => {
        const { api, calls } = client([{ body: { content: {}, links: [], metadata: {} } }], {
            STEEL_BASE_URL: 'http://localhost:3000',
        });
        await api.scrape({ url: 'https://example.com', format: ['markdown'] });
        expect(calls[0]!.url).toBe('http://localhost:3000/v1/scrape');
        expect(calls[0]!.headers.authorization).toBeUndefined();
    });

    it('does not double the /v1 prefix when the base URL already carries it', async () => {
        const { api, calls } = client([{ body: { content: {}, links: [], metadata: {} } }], {
            STEEL_API_KEY: 'k',
            STEEL_BASE_URL: 'https://api.steel.dev/v1',
        });
        await api.scrape({ url: 'https://example.com', format: ['markdown'] });
        expect(calls[0]!.url).toBe('https://api.steel.dev/v1/scrape');
    });
});

describe('SteelRestClient artifact endpoints', () => {
    it('returns the hosted URL for a screenshot rather than bytes', async () => {
        const { api } = client([{ body: { url: 'https://files.steel.dev/v1/static/abc.png' } }]);
        const result = await api.screenshot({ url: 'https://example.com', fullPage: true });
        expect(result).toEqual({ kind: 'hosted', url: 'https://files.steel.dev/v1/static/abc.png' });
    });

    it('returns the hosted URL for a PDF rather than bytes', async () => {
        const { api } = client([{ body: { url: 'https://files.steel.dev/v1/static/abc.pdf' } }]);
        expect(await api.pdf({ url: 'https://example.com' })).toEqual({
            kind: 'hosted',
            url: 'https://files.steel.dev/v1/static/abc.pdf',
        });
    });

    it('accepts raw screenshot and PDF bytes from the cluster browser', async () => {
        const { api } = client(
            [
                { rawBody: 'JFIF-image', headers: { 'content-type': 'application/octet-stream' } },
                { rawBody: '%PDF-1.4', headers: { 'content-type': 'application/octet-stream' } },
            ],
            { STEEL_BASE_URL: 'http://browser:3000' }
        );

        expect(await api.screenshot({ url: 'https://example.com' })).toEqual({
            kind: 'inline',
            data: Buffer.from('JFIF-image').toString('base64'),
            mimeType: 'image/jpeg',
            size: Buffer.byteLength('JFIF-image'),
        });
        expect(await api.pdf({ url: 'https://example.com' })).toEqual({
            kind: 'inline',
            data: Buffer.from('%PDF-1.4').toString('base64'),
            mimeType: 'application/pdf',
            size: Buffer.byteLength('%PDF-1.4'),
        });
    });
});

describe('SteelRestClient.createSession', () => {
    it('passes the client-minted session id, a hard timeout and an inactivity timeout', async () => {
        const { api, calls } = client([{ body: { id: 'mine-1', status: 'live', createdAt: '2026-07-27T00:00:00Z' } }]);
        await api.createSession({ sessionId: 'mine-1', timeout: 900_000, inactivityTimeout: 120_000 });
        expect(calls[0]!.url).toBe('https://api.steel.dev/v1/sessions');
        expect(calls[0]!.body).toMatchObject({
            sessionId: 'mine-1',
            timeout: 900_000,
            inactivityTimeout: 120_000,
        });
    });

    it('passes mobile device configuration through unchanged', async () => {
        const { api, calls } = client([{ body: { id: 'mobile-1', status: 'live' } }]);
        await api.createSession({
            sessionId: 'mobile-1',
            timeout: 900_000,
            deviceConfig: { device: 'mobile' },
        });
        expect(calls[0]!.body).toMatchObject({ deviceConfig: { device: 'mobile' } });
    });

    it('retains advanced region placement at the internal REST boundary', async () => {
        const { api, calls } = client([{ body: { id: 'regional-1', status: 'live' } }]);
        await api.createSession({ sessionId: 'regional-1', timeout: 900_000, region: 'lax' });

        expect(calls[0]!.body).toMatchObject({ region: 'lax' });
    });

    it('never sends a metadata field, which the sessions endpoint does not have', async () => {
        const { api, calls } = client([{ body: { id: 'mine-1', status: 'live' } }]);
        await api.createSession({
            sessionId: 'mine-1',
            timeout: 1000,
            inactivityTimeout: 500,
            namespace: 'ns',
            credentials: { autoSubmit: true, blurFields: true, exactOrigin: true },
        });
        expect(calls[0]!.body).not.toHaveProperty('metadata');
        expect(calls[0]!.body).toMatchObject({
            namespace: 'ns',
            credentials: { autoSubmit: true, blurFields: true, exactOrigin: true },
        });
    });

    it('omits keys the caller did not set instead of sending nulls', async () => {
        const { api, calls } = client([{ body: { id: 'mine-1', status: 'live' } }]);
        await api.createSession({ sessionId: 'mine-1', timeout: 1000, inactivityTimeout: 500 });
        expect(Object.keys(calls[0]!.body as object).sort()).toEqual(['inactivityTimeout', 'sessionId', 'timeout']);
    });

    it('passes the stable profile selector and persistence flag to a self-hosted browser', async () => {
        const profileId = 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa';
        const { api, calls } = client([{ body: { id: 'mine-1', status: 'live' } }]);
        await api.createSession({ sessionId: 'mine-1', timeout: 900_000, profileId, persist: true });
        expect(calls[0]!.body).toMatchObject({ profileId, persist: true });
    });
});

describe('SteelRestClient.releaseSession', () => {
    it('posts to the release path', async () => {
        const { api, calls } = client([{ body: { success: true } }]);
        await api.releaseSession('abc');
        expect(calls[0]!.url).toBe('https://api.steel.dev/v1/sessions/abc/release');
        expect(calls[0]!.method).toBe('POST');
    });

    it('treats an unknown session as already released', async () => {
        const { api } = client([{ status: 404, body: { message: 'Session not found' } }]);
        await expect(api.releaseSession('gone')).resolves.toBeUndefined();
    });
});

describe('SteelRestClient error handling', () => {
    it('maps a failing status through the error layer and keeps Retry-After', async () => {
        const { api } = client([{ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '30' } }]);
        const error = await captureError(api.scrape({ url: 'https://x.test', format: ['markdown'] }));
        expect(error).toBeInstanceOf(SteelToolError);
        expect(error.code).toBe('rate_limited');
        expect(error.retryAfterSeconds).toBe(30);
        expect(error.message).toMatch(/Browser Tools/);
    });

    it('classifies a session-create failure as a session-create failure', async () => {
        const { api } = client([{ status: 429, body: { message: 'slow down' } }]);
        const error = await captureError(api.createSession({ sessionId: 's', timeout: 1, inactivityTimeout: 1 }));
        expect(error.message).toMatch(/concurrent session/i);
    });

    it('survives a non-JSON error body', async () => {
        const { fetchImpl } = { fetchImpl: async () => new Response('<html>502</html>', { status: 502 }) };
        const api = new SteelRestClient(loadConfig({ STEEL_API_KEY: 'k' }), fetchImpl);
        const error = await captureError(api.scrape({ url: 'https://x.test', format: ['markdown'] }));
        expect(error).toBeInstanceOf(SteelToolError);
        expect(error.code).toBe('steel_error');
        expect(error.message).toContain('502');
    });
});

describe('SteelRestClient trace propagation', () => {
    it('sends no traceparent header when nothing is tracing the call', async () => {
        const { api, calls } = client([{ body: { content: {}, links: [], metadata: {} } }]);
        await api.scrape({ url: 'https://example.com', format: ['markdown'] });
        expect(calls[0]!.headers).not.toHaveProperty('traceparent');
    });

    it('puts its own client span on the wire as a traceparent header', async () => {
        const harness = tracingHarness();
        const { api, calls } = client([{ body: { content: {}, links: [], metadata: {} } }], undefined, harness.tracer);

        await harness.tracer.startActiveSpan('tools/call browser_scrape', async span => {
            await api.scrape({ url: 'https://example.com', format: ['markdown'] });
            span.end();
        });

        const clientSpan = harness.span('steel browser_tool');
        const { traceId, spanId } = clientSpan.spanContext();
        expect(calls[0]!.headers.traceparent).toBe(`00-${traceId}-${spanId}-01`);
        expect(clientSpan.parentSpanContext?.spanId).toBe(harness.span('tools/call browser_scrape').spanContext().spanId);
        await harness.shutdown();
    });

    it('describes the request without the credential or a query string', async () => {
        const harness = tracingHarness();
        const { api } = client([{ body: { content: {}, links: [], metadata: {} } }], undefined, harness.tracer);

        await api.scrape({ url: 'https://example.com', format: ['markdown'] });

        const span = harness.span('steel browser_tool');
        expect(span.kind).toBe(SpanKind.CLIENT);
        expect(span.attributes).toEqual({
            'http.request.method': 'POST',
            'url.path': '/v1/scrape',
            'server.address': 'api.steel.dev',
            'steel.operation': 'browser_tool',
            'http.response.status_code': 200,
        });
        expect(JSON.stringify(span.attributes)).not.toContain('ste-secret');
        await harness.shutdown();
    });

    it('keeps historical-list filters out of the traced URL path', async () => {
        const harness = tracingHarness();
        const { api } = client([{ body: { sessions: [], nextCursor: null } }], undefined, harness.tracer);

        await api.listSessions({ status: 'released', limit: 1 });

        expect(harness.span('steel account').attributes['url.path']).toBe('/v1/sessions');
        await harness.shutdown();
    });

    it('marks the client span failed with the mapped error code', async () => {
        const harness = tracingHarness();
        const { api } = client([{ status: 429, body: { message: 'slow down' } }], undefined, harness.tracer);

        await captureError(api.scrape({ url: 'https://x.test', format: ['markdown'] }));

        const span = harness.span('steel browser_tool');
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(span.attributes['error.type']).toBe('rate_limited');
        await harness.shutdown();
    });
});

describe('SteelRestClient diagnostics endpoints', () => {
    it('lists the newest released session without starting one', async () => {
        const { api, calls } = client([
            {
                body: {
                    sessions: [
                        {
                            id: '7dbe8308-59f0-4f6f-8685-8fe9673d98fa',
                            createdAt: '2026-08-05T11:00:00.000Z',
                            status: 'released',
                        },
                    ],
                    nextCursor: null,
                    totalCount: 1,
                },
            },
        ]);

        const sessions = await api.listSessions({ status: 'released', limit: 1 });

        expect(calls[0]!.url).toBe('https://api.steel.dev/v1/sessions?status=released&limit=1');
        expect(calls[0]!.method).toBe('GET');
        expect(sessions.sessions[0]?.id).toBe('7dbe8308-59f0-4f6f-8685-8fe9673d98fa');
    });

    it('reads agent traces and session logs', async () => {
        const { api, calls } = client([
            { body: { events: [{ timestamp: '2026-07-27T00:00:00Z', type: 'click' }], total: 1, hasMore: false } },
            { body: [{ timestamp: '2026-07-27T00:00:01Z', text: 'nav' }] },
        ]);
        await api.getAgentTraces('abc');
        await api.getSessionLogs('abc');
        expect(calls[0]!.url).toBe('https://api.steel.dev/v1/sessions/abc/agent-traces');
        expect(calls[1]!.url).toBe('https://api.steel.dev/v1/sessions/abc/logs');
    });

    it('answers agent traces with the envelope Steel sends, not a bare array', async () => {
        // Verbatim from a live call against a finished session, which is what the shape must match.
        const { api } = client([
            {
                body: {
                    events: [
                        {
                            timestamp: '2026-07-30T16:19:02.165Z',
                            type: 'navigate',
                            navigation: { url: 'about:blank' },
                        },
                    ],
                    total: 1,
                    hasMore: false,
                },
            },
        ]);

        const timeline = await api.getAgentTraces('abc');

        expect(timeline.total).toBe(1);
        expect(timeline.hasMore).toBe(false);
        expect(timeline.events).toEqual([
            { timestamp: '2026-07-30T16:19:02.165Z', type: 'navigate', navigation: { url: 'about:blank' } },
        ]);
    });

    it('answers with an empty timeline when the body carries no events array', async () => {
        const { api } = client([{ body: { total: 0, hasMore: false } }]);
        const timeline = await api.getAgentTraces('abc');
        expect(timeline.events).toEqual([]);
    });

    it('answers session logs with the envelope Steel sends, not a bare array', async () => {
        // Verbatim from a live call: entries name themselves with `type` and carry `log` as a
        // JSON-encoded string, which is nothing like the flat {level,text} shape once assumed.
        const { api } = client([
            {
                body: {
                    events: [
                        {
                            id: 'sess-0-12',
                            type: 'RequestFailed',
                            timestamp: '2026-07-31T11:11:59.330Z',
                            log: '{"pageId":"15F9","error":{"message":"net::ERR_FAILED","url":"https://ads.test/a.js"},"createdAt":1785496290115}',
                        },
                    ],
                    total: 1,
                    hasMore: false,
                },
            },
        ]);

        const logs = await api.getSessionLogs('abc');

        expect(logs.total).toBe(1);
        expect(logs.hasMore).toBe(false);
        expect(logs.events[0]!.type).toBe('RequestFailed');
        expect(logs.events[0]!.log).toContain('net::ERR_FAILED');
    });

    it('answers with an empty log timeline when the body carries no events array', async () => {
        const { api } = client([{ body: { total: 0, hasMore: false } }]);
        const logs = await api.getSessionLogs('abc');
        expect(logs.events).toEqual([]);
    });
});

describe('SteelRestClient session replay', () => {
    it('retrieves an authenticated HLS playlist as text and encodes the historical session id', async () => {
        const playlist =
            '#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:2.000,\nhttps://recordings.test/segment.ts?token=short-lived\n';
        const { api, calls } = client([{ rawBody: playlist }]);

        const result = await api.getSessionHls('old/session');

        expect(result).toBe(playlist);
        expect(calls[0]!.url).toBe('https://api.steel.dev/v1/sessions/old%2Fsession/hls');
        expect(calls[0]!.method).toBe('GET');
        expect(calls[0]!.headers.authorization).toBe('Bearer ste-secret');
        expect(calls[0]!.headers.accept).toBe('application/vnd.apple.mpegurl');
    });

    it('rejects a malformed successful response without exposing its body', async () => {
        const privateBody = '<html>gateway response containing credential=private-recording-token</html>';
        const { api } = client([{ rawBody: privateBody }]);

        const error = await captureError(api.getSessionHls('finished'));

        expect(error).toBeInstanceOf(SteelToolError);
        expect(error.code).toBe('steel_error');
        expect(error.message).toMatch(/invalid HLS playlist/i);
        expect(error.message).not.toContain(privateBody);
        expect(error.message).not.toContain('private-recording-token');
    });

    it('maps an HLS HTTP failure through the normal Steel error layer', async () => {
        const { api } = client([{ status: 404, body: { message: 'Recording is not ready' } }]);

        const error = await captureError(api.getSessionHls('finished'));

        expect(error.code).toBe('not_found');
        expect(error.message).toBe('Recording is not ready');
    });
});

describe('SteelRestClient safe account catalogs', () => {
    it('projects profile metadata and drops every rich upstream field', async () => {
        const { api, calls } = client([
            {
                body: {
                    profiles: [
                        {
                            id: 'p1',
                            status: 'READY',
                            createdAt: 'c',
                            updatedAt: 'u',
                            fingerprint: { secret: true },
                            proxyUrl: 'private',
                            credentialsConfig: { value: 'secret' },
                        },
                        { id: 4 },
                    ],
                },
            },
        ]);
        await expect(api.listProfiles()).resolves.toEqual([
            { id: 'p1', status: 'READY', createdAt: 'c', updatedAt: 'u' },
        ]);
        expect(calls[0]?.url).toBe('https://api.steel.dev/v1/profiles');
    });

    it('encodes profile ids and projects one profile', async () => {
        const { api, calls } = client([
            { body: { id: 'p/1', status: 'UPLOADING', createdAt: 'c', updatedAt: 'u', sourceSessionId: 'secret' } },
        ]);
        await expect(api.getProfile('p/1')).resolves.toEqual({
            id: 'p/1',
            status: 'UPLOADING',
            createdAt: 'c',
            updatedAt: 'u',
        });
        expect(calls[0]?.url).toBe('https://api.steel.dev/v1/profiles/p%2F1');
    });

    it('encodes credential filters and never returns labels or values', async () => {
        const { api, calls } = client([
            {
                body: {
                    credentials: [
                        {
                            namespace: 'n&x',
                            origin: 'https://example.com',
                            createdAt: 'c',
                            updatedAt: 'u',
                            label: 'free text',
                            value: 'secret',
                            username: 'private',
                            totpSecret: 'private',
                        },
                    ],
                },
            },
        ]);
        await expect(api.listCredentials({ origin: 'https://example.com', namespace: 'n&x' })).resolves.toEqual([
            { namespace: 'n&x', origin: 'https://example.com', createdAt: 'c', updatedAt: 'u' },
        ]);
        expect(calls[0]?.url).toBe(
            'https://api.steel.dev/v1/credentials?origin=https%3A%2F%2Fexample.com&namespace=n%26x'
        );
    });
});
