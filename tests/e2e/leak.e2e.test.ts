// ABOUTME: The leak test: a client that vanishes mid-session must not leave a billed browser
// ABOUTME: running. Drives the real stdio binary against a real self-hosted steel-browser.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { SteelRestClient } from '../../src/core/steel/rest.js';
import { announceStack, describeStack, E2E_ENV, STEEL_BASE_URL, stackIsUp } from './stack.js';

const BINARY = fileURLToPath(new URL('../../dist/stdio.js', import.meta.url));
const available = (await stackIsUp()) && existsSync(BINARY);
const reason = describeStack(available);
announceStack(available, 'leak E2E');

const api = new SteelRestClient(loadConfig(E2E_ENV));

async function liveSessionIds(): Promise<string[]> {
    const response = await fetch(`${STEEL_BASE_URL}/v1/sessions`);
    if (!response.ok) return [];
    const body = (await response.json()) as unknown;
    const list = Array.isArray(body) ? body : ((body as { sessions?: unknown[] }).sessions ?? []);
    return (list as Array<{ id?: string; status?: string }>)
        .filter(session => session.status === 'live')
        .map(session => session.id ?? '');
}

beforeAll(async () => {
    if (!available) return;
    // Start from a clean slate: another suite may have left a session behind.
    for (const id of await liveSessionIds()) await api.releaseSession(id).catch(() => undefined);
});

describe.skipIf(!available)(`billed-session teardown (${reason})`, () => {
    it('releases the browser when the client goes away mid-session', async () => {
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [BINARY],
            env: { ...process.env, STEEL_BASE_URL, STEEL_API_KEY: '', STEEL_PROFILE: 'browse' },
            stderr: 'pipe',
        });
        const client = new Client({ name: 'leak-test', version: '1.0.0' });
        await client.connect(transport);

        const before = new Set(await liveSessionIds());
        const created = await client.callTool({ name: 'browser_session_create', arguments: {} });
        const handle = (created as { structuredContent?: { session_id?: string } }).structuredContent?.session_id;
        expect(handle, `session_create failed: ${JSON.stringify(created)}`).toBeTruthy();

        await client.callTool({
            name: 'browser_navigate',
            arguments: { session_id: handle, url: 'http://fixture-site:8099/' },
        });

        // Assert on the session this client started, not on the global list, so a session left
        // behind by anything else cannot make this pass or fail for the wrong reason.
        const started = (await liveSessionIds()).filter(id => !before.has(id));
        expect(started, 'no new browser session appeared').toHaveLength(1);

        // The client vanishing is the case the shutdown hook and the reaper exist for.
        await client.close();

        const deadline = Date.now() + 20_000;
        let stillLive = await liveSessionIds();
        while (stillLive.includes(started[0]!) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 500));
            stillLive = await liveSessionIds();
        }
        expect(stillLive, 'a browser session outlived the client that created it').not.toContain(started[0]);
    }, 60_000);

    it('releases a session the tool layer was asked to release', async () => {
        const sessionId = crypto.randomUUID();
        await api.createSession({ sessionId, timeout: 60_000, inactivityTimeout: 30_000 });
        expect(await liveSessionIds()).toContain(sessionId);

        await api.releaseSession(sessionId);
        expect(await liveSessionIds()).not.toContain(sessionId);
    });
});
