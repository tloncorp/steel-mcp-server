// ABOUTME: Real-Chrome navigation policy checks through the model-facing MCP tools.
// ABOUTME: Unsafe schemes cannot execute page code through direct or batched navigation.
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { CdpSessionPool } from '../../src/core/context.js';
import { createSteelMcpServer } from '../../src/core/server.js';
import { CdpConnection } from '../../src/core/steel/cdp.js';
import { testDeps } from '../helpers/fakes.js';
import { announceMissing, findChrome, HeadlessChrome } from '../helpers/headless-chrome.js';

const binary = findChrome();
announceMissing('Navigation policy', binary ? [] : ['Chrome']);

describe.skipIf(!binary)('model navigation in Chrome', () => {
    it('blocks script execution in direct and batched navigation while retaining HTTP navigation', async () => {
        const browser = await HeadlessChrome.launch(binary!);
        const site = createServer((_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end('<title>Unchanged</title><h1>Navigation fixture</h1>');
        });
        const config = loadConfig({ STEEL_LOCAL: 'true' });
        const pool = new CdpSessionPool(config, 1, () => CdpConnection.connect(browser.debuggerUrl));
        const deps = testDeps({ env: { STEEL_LOCAL: 'true' }, pool });
        const server = createSteelMcpServer(deps);
        const client = new Client({ name: 'navigation-policy', version: '1' });
        try {
            await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
            const address = site.address();
            if (!address || typeof address === 'string') throw new Error('No fixture listener');
            const url = `http://127.0.0.1:${address.port}/`;
            const record = await deps.registry.create({
                principal: deps.principal,
                steelSessionId: 'navigation-fixture',
                expiresAt: Date.now() + 60_000,
            });
            const [ct, st] = InMemoryTransport.createLinkedPair();
            await server.connect(st);
            await client.connect(ct);
            const opened = await client.callTool({
                name: 'browser_navigate',
                arguments: { session_id: record.handle, url },
            });
            expect(opened.isError).not.toBe(true);
            for (const name of ['browser_navigate', 'browser_batch']) {
                const unsafe = 'javascript:document.title="Executed"';
                const result = await client.callTool({
                    name,
                    arguments:
                        name === 'browser_navigate'
                            ? { session_id: record.handle, url: unsafe }
                            : {
                                  session_id: record.handle,
                                  steps: [{ tool: 'browser_navigate', arguments: { url: unsafe } }],
                              },
                });
                expect(JSON.stringify(result)).toContain('invalid_argument');
                const page = await pool.page('navigation-fixture');
                expect(await page.pageSummary()).toEqual({ title: 'Unchanged', url });
            }
        } finally {
            await client.close();
            await server.close();
            await pool.closeAll();
            site.closeAllConnections();
            if (site.listening) await new Promise<void>(resolve => site.close(() => resolve()));
            await browser.close();
        }
    });
});
