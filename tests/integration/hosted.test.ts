// ABOUTME: Integration tests for the hosted entrypoint over a real socket: what it serves, what it
// ABOUTME: refuses to start without, and that shutting it down releases every browser it started.
import { request as httpRequest } from 'node:http';
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { type HostedServer, startHostedServer } from '../../src/hosted.js';
import { FakeSteelApi, testDeps } from '../helpers/fakes.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

const BASE_ENV: Record<string, string | undefined> = {
    HOST: '127.0.0.1',
    PORT: '0',
    STEEL_ALLOWED_HOSTS: '127.0.0.1,mcp.steel.dev',
};

interface RawResponse {
    status: number;
    body: string;
}

/** Node's http client rather than fetch, because these tests set Host headers fetch will not send. */
function raw(
    port: number,
    options: { method: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            { host: '127.0.0.1', port, method: options.method, path: options.path, headers: options.headers },
            response => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => {
                    body += chunk;
                });
                response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
            }
        );
        req.on('error', reject);
        if (options.body !== undefined) req.write(options.body);
        req.end();
    });
}

function toolCall(
    port: number,
    credential: string,
    name: string,
    args: Record<string, unknown>,
    host = '127.0.0.1',
    credentialHeader: 'authorization' | 'x-api-key' = 'authorization'
): Promise<RawResponse> {
    const credentialHeaders: Record<string, string> =
        credentialHeader === 'authorization' ? { authorization: `Bearer ${credential}` } : { 'x-api-key': credential };
    return raw(port, {
        method: 'POST',
        path: '/mcp',
        headers: {
            host,
            ...credentialHeaders,
            accept: 'application/json',
            'content-type': 'application/json',
            'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
            'mcp-method': 'tools/call',
            'mcp-name': name,
        },
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

const running: HostedServer[] = [];

afterEach(async () => {
    await Promise.all(running.splice(0).map(server => server.close()));
});

/** Starts the entrypoint with a fake Steel behind it, so nothing here reaches the network. */
async function start(
    env: Record<string, string | undefined> = {}
): Promise<{ server: HostedServer; api: FakeSteelApi }> {
    const api = new FakeSteelApi();
    const server = await startHostedServer({
        env: { ...BASE_ENV, ...env },
        runtime: { createApi: () => api, createPool: () => testDeps().pool },
        log: () => {},
    });
    running.push(server);
    return { server, api };
}

describe('the hosted entrypoint', () => {
    it('serves a tool call over a real socket, using the credential the caller sent', async () => {
        const { server, api } = await start();

        const response = await toolCall(server.port, 'ste-caller', 'browser_scrape', { url: 'https://example.com/' });

        expect(response.status).toBe(200);
        const body = JSON.parse(response.body) as { result: { isError?: boolean } };
        expect(body.result.isError ?? false).toBe(false);
        expect(api.scrapes).toHaveLength(1);
    });

    it('rejects a Host outside the allowlist, which is the DNS-rebinding guard', async () => {
        const { server } = await start();

        const response = await toolCall(server.port, 'ste-caller', 'browser_scrape', {}, 'evil.test');

        expect(response.status).toBe(403);
    });

    it('answers a health probe whose Host a load balancer will not have set', async () => {
        const { server } = await start();

        const response = await raw(server.port, { method: 'GET', path: '/healthz', headers: { host: '10.0.0.7' } });

        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' });
    });

    it('never answers a health probe with anything about a caller', async () => {
        const { server } = await start();

        const response = await raw(server.port, { method: 'GET', path: '/healthz', headers: { host: '127.0.0.1' } });

        expect(response.body).not.toContain('ste-');
    });

    it('refuses to start without a Host allowlist, rather than accepting every Host', async () => {
        await expect(
            startHostedServer({ env: { ...BASE_ENV, STEEL_ALLOWED_HOSTS: undefined }, log: () => {} })
        ).rejects.toThrow(/STEEL_ALLOWED_HOSTS/);
    });

    it('uses X-Api-Key as tenant identity while serving a self-hosted browser', async () => {
        const { server, api } = await start({
            STEEL_LOCAL: 'true',
            STEEL_BASE_URL: 'http://steel-browser:3000',
        });

        const response = await toolCall(
            server.port,
            'moon-secret',
            'browser_scrape',
            { url: 'https://example.com/' },
            '127.0.0.1',
            'x-api-key'
        );

        expect(response.status).toBe(200);
        const body = JSON.parse(response.body) as { result: { isError?: boolean } };
        expect(body.result.isError ?? false).toBe(false);
        expect(api.scrapes).toHaveLength(1);
    });

    it('releases every browser it started when it shuts down', async () => {
        const { server, api } = await start();

        const created = await toolCall(server.port, 'ste-caller', 'browser_session_create', {});
        expect(created.status).toBe(200);
        expect(api.created).toHaveLength(1);
        const steelSessionId = api.created[0]?.sessionId as string;

        await server.close();
        running.length = 0;

        expect(api.released).toContain(steelSessionId);
    });
});
