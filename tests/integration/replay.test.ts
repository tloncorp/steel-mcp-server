// ABOUTME: Pins the dashboard-only replay contract through a real MCP client at the Steel REST boundary.
// ABOUTME: Replay resolves existing sessions, never starts a browser, and never reads private HLS data.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { SteelToolError } from '../../src/core/errors.js';
import { createSteelMcpServer } from '../../src/core/server.js';
import type { SteelSession } from '../../src/core/steel/types.js';
import { FakeSteelApi, testDeps } from '../helpers/fakes.js';

const EXPLICIT_ID = '11111111-1111-4111-8111-111111111111';
const LATEST_ID = '22222222-2222-4222-8222-222222222222';

type Deps = ReturnType<typeof testDeps>;

interface Harness {
    client: Client;
    deps: Deps;
    close(): Promise<void>;
}

interface ReplayStructured {
    finished_session_id?: string;
    status?: string;
    selected_by?: string;
    dashboard_url?: string;
}

const harnesses = new Set<Harness>();

async function connect(api: FakeSteelApi, deployment: 'cloud' | 'self_hosted' = 'cloud'): Promise<Harness> {
    const deps = testDeps({ api, env: deployment === 'self_hosted' ? { STEEL_BASE_URL: 'http://steel:3000' } : {} });
    const server = createSteelMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'replay-contract-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const harness: Harness = {
        client,
        deps,
        close: async () => {
            harnesses.delete(harness);
            await client.close();
            await server.close();
        },
    };
    harnesses.add(harness);
    return harness;
}

afterEach(async () => {
    await Promise.all([...harnesses].map(harness => harness.close()));
});

function textOf(result: unknown): string {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    return content
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n');
}

function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
}

function structuredOf(result: unknown): ReplayStructured | undefined {
    return (result as { structuredContent?: ReplayStructured }).structuredContent;
}

function releasedSession(
    id: string,
    sessionViewerUrl: string | null = `https://app.steel.dev/sessions/${id}`
): SteelSession & { status: 'released' } {
    if (sessionViewerUrl === null) return { id, status: 'released' };
    return { id, status: 'released', sessionViewerUrl };
}

function expectNoSessionMutation(api: FakeSteelApi): void {
    expect(api.created).toEqual([]);
    expect(api.released).toEqual([]);
    expect(api.hlsReads).toEqual([]);
}

describe('browser_session_replay descriptor', () => {
    it('keeps the strict optional UUID but has no replay app resource URI', async () => {
        const harness = await connect(new FakeSteelApi());
        const replay = (await harness.client.listTools()).tools.find(tool => tool.name === 'browser_session_replay');

        expect(replay?.description).toMatch(/explicitly asks.*watch or replay/i);
        expect(replay?.description).toMatch(/diagnostics.*inspect or explain/i);
        expect(replay?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
        expect(
            (replay as { _meta?: { ui?: { resourceUri?: string } } } | undefined)?._meta?.ui?.resourceUri
        ).toBeUndefined();

        const schema = replay?.inputSchema as
            | { properties?: Record<string, { pattern?: string }>; required?: string[]; additionalProperties?: boolean }
            | undefined;
        expect(Object.keys(schema?.properties ?? {})).toEqual(['finished_session_id']);
        expect(schema?.properties?.finished_session_id?.pattern).toMatch(/0-9a-f/);
        expect(schema?.required ?? []).toEqual([]);
        expect(schema?.additionalProperties).toBe(false);
    });

    it('rejects an old MCP session_id before selecting a latest session', async () => {
        const api = new FakeSteelApi({ sessions: { sessions: [releasedSession(LATEST_ID)] } });
        const harness = await connect(api);
        const result = await harness.client.callTool({
            name: 'browser_session_replay',
            arguments: { session_id: 'sess_old_handle' },
        });

        expect(isError(result)).toBe(true);
        expect(api.sessionLists).toEqual([]);
        expect(api.sessionReads).toEqual([]);
        expectNoSessionMutation(api);
    });
});

describe('browser_session_replay dashboard delivery', () => {
    it('returns only the safe dashboard link for an explicit released UUID', async () => {
        const api = new FakeSteelApi({
            sessionsById: { [EXPLICIT_ID]: releasedSession(EXPLICIT_ID) },
        });
        const harness = await connect(api);
        const result = await harness.client.callTool({
            name: 'browser_session_replay',
            arguments: { finished_session_id: EXPLICIT_ID },
        });

        expect(isError(result)).toBe(false);
        expect(api.sessionReads).toEqual([EXPLICIT_ID]);
        expect(api.sessionLists).toEqual([]);
        expect(structuredOf(result)).toEqual({
            finished_session_id: EXPLICIT_ID,
            status: 'released',
            selected_by: 'explicit',
            dashboard_url: `https://app.steel.dev/sessions/${EXPLICIT_ID}`,
        });
        expect(textOf(result)).toMatch(/inline replay is temporarily unavailable/i);
        expect(JSON.stringify(result)).not.toMatch(/steel\/replay|#EXTM3U|private-signed-url|kind.*hls|manifest/i);
        expectNoSessionMutation(api);
    });

    it('selects exactly the newest released session when the UUID is omitted', async () => {
        const api = new FakeSteelApi({
            sessions: { sessions: [releasedSession(LATEST_ID)], nextCursor: 'older' },
            sessionsById: { [LATEST_ID]: releasedSession(LATEST_ID) },
        });
        const harness = await connect(api);
        const result = await harness.client.callTool({ name: 'browser_session_replay', arguments: {} });

        expect(isError(result)).toBe(false);
        expect(api.sessionLists).toEqual([{ status: 'released', limit: 1 }]);
        expect(api.sessionReads).toEqual([LATEST_ID]);
        expect(structuredOf(result)).toMatchObject({
            finished_session_id: LATEST_ID,
            selected_by: 'latest_released',
            dashboard_url: `https://app.steel.dev/sessions/${LATEST_ID}`,
        });
        expectNoSessionMutation(api);
    });

    it('normalizes forbidden and missing explicit sessions without leaking upstream details', async () => {
        for (const code of ['forbidden', 'not_found'] as const) {
            const api = new FakeSteelApi({
                sessionsById: {
                    [EXPLICIT_ID]: new SteelToolError(`private ${code} marker`, { code, details: { secret: true } }),
                },
            });
            const harness = await connect(api);
            const result = await harness.client.callTool({
                name: 'browser_session_replay',
                arguments: { finished_session_id: EXPLICIT_ID },
            });

            expect(isError(result)).toBe(true);
            expect(
                (result as { structuredContent?: { error?: { code?: string } } }).structuredContent?.error?.code
            ).toBe('not_found');
            expect(JSON.stringify(result)).not.toMatch(/private|secret/);
            expectNoSessionMutation(api);
        }
    });

    it('rejects live, unsafe, and missing dashboard targets without reading HLS', async () => {
        const cases: Array<[string, SteelSession]> = [
            [
                'live',
                { id: EXPLICIT_ID, status: 'live', sessionViewerUrl: `https://app.steel.dev/sessions/${EXPLICIT_ID}` },
            ],
            [
                'unsafe',
                releasedSession(EXPLICIT_ID, `https://app.steel.dev@evil.test/sessions/${EXPLICIT_ID}?key=secret`),
            ],
            ['missing', releasedSession(EXPLICIT_ID, null)],
        ];

        for (const [_label, session] of cases) {
            const api = new FakeSteelApi({ sessionsById: { [EXPLICIT_ID]: session } });
            const harness = await connect(api);
            const result = await harness.client.callTool({
                name: 'browser_session_replay',
                arguments: { finished_session_id: EXPLICIT_ID },
            });

            expect(isError(result)).toBe(true);
            expect(JSON.stringify(result)).not.toMatch(/evil\.test|key=secret/);
            expectNoSessionMutation(api);
        }
    });

    it('keeps dashboard replay explicitly unsupported for self-hosted deployments', async () => {
        const api = new FakeSteelApi({ sessionsById: { [EXPLICIT_ID]: releasedSession(EXPLICIT_ID) } });
        const harness = await connect(api, 'self_hosted');
        const result = await harness.client.callTool({
            name: 'browser_session_replay',
            arguments: { finished_session_id: EXPLICIT_ID },
        });

        expect(isError(result)).toBe(true);
        expect((result as { structuredContent?: { error?: { code?: string } } }).structuredContent?.error?.code).toBe(
            'self_host_unsupported'
        );
        expect(api.sessionReads).toEqual([]);
        expectNoSessionMutation(api);
    });
});
