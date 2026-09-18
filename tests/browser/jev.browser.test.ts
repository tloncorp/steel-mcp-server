// ABOUTME: Drives a real Chromium page through browser_run with deterministic OpenRouter decisions.
// ABOUTME: Verifies the runner reuses its browser and cookies and fills/searches without a second model.
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
announceMissing('Jev browser runner', binary ? [] : ['Chrome']);

describe.skipIf(!binary)('Jev on an existing real browser', () => {
    it('fills a search field, submits search and preserves the session cookie', async () => {
        const browser = await HeadlessChrome.launch(binary!);
        const site = createServer((req, res) => {
            res.setHeader('Content-Type', 'text/html');
            if (req.url?.startsWith('/results')) {
                res.end(
                    `<h1>Results</h1><p>espresso</p><p>${req.headers.cookie === 'owner=test-owner' ? 'Cookie preserved' : 'Missing cookie'}</p>`
                );
            } else {
                res.setHeader('Set-Cookie', 'owner=test-owner; Path=/; HttpOnly');
                res.end(
                    '<h1>Library</h1><form action="/results"><label>Search query<input name="q"></label><button type="submit">Search</button></form>'
                );
            }
        });
        const env = { STEEL_LOCAL: 'true', OPENROUTER_API_KEY: 'test-only-key' };
        const pool = new CdpSessionPool(loadConfig(env), 1, async url => {
            expect(new URL(url).searchParams.get('sessionId')).toBe('existing-browser');
            return CdpConnection.connect(browser.debuggerUrl);
        });
        let client: Client | undefined;
        let server: ReturnType<typeof createSteelMcpServer> | undefined;
        try {
            await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
            const address = site.address();
            if (!address || typeof address === 'string') throw new Error('No test listener');
            const page = await pool.page('existing-browser');
            await page.navigate(`http://127.0.0.1:${address.port}/`);
            const deps = testDeps({ env, pool });
            let calls = 0;
            deps.jevFetch = async (_url, init) => {
                const body = JSON.parse(String(init?.body));
                const criteria = body.questions.action.criteria as Record<string, string>;
                const done = String(body.state.page).includes('Results');
                const action = done
                    ? 'done'
                    : Object.entries(criteria).find(([, label]) =>
                          calls === 0 ? label.startsWith('Fill textbox Search query') : label === 'Click button Search'
                      )?.[0];
                expect(action).toBeTruthy();
                calls++;
                return Response.json({
                    model: '~typesafe/jev-latest',
                    answers: {
                        action: { type: 'choice', choice: action, confidence: 1 },
                        goal_done: { type: 'noul', noul: done ? 1 : 0 },
                        stuck: { type: 'noul', noul: 0 },
                        confirmation: { type: 'noul', noul: 0 },
                    },
                    usage: { input_tokens: 100, output_tokens: 10 },
                });
            };
            const record = await deps.registry.create({
                principal: deps.principal,
                steelSessionId: 'existing-browser',
                expiresAt: Date.now() + 60_000,
            });
            server = createSteelMcpServer(deps);
            client = new Client({ name: 'real-browser-test', version: '1' });
            const [ct, st] = InMemoryTransport.createLinkedPair();
            await server.connect(st);
            await client.connect(ct);
            const result = await client.callTool({
                name: 'browser_run',
                arguments: {
                    session_id: record.handle,
                    task: 'Search for espresso and read results',
                    inputs: [{ field: 'Search query', value: 'espresso' }],
                },
            });
            expect(result.structuredContent).toMatchObject({
                status: 'done',
                usage: { calls: 3, cost_reported: false },
            });
            expect(JSON.stringify(result)).toContain('Cookie preserved');
            expect((await page.pageSummary()).url).toContain('/results?q=espresso');
            expect(deps.api.created).toHaveLength(0);
        } finally {
            await client?.close();
            await server?.close();
            await pool.closeAll();
            site.closeAllConnections();
            if (site.listening) await new Promise<void>(resolve => site.close(() => resolve()));
            await browser.close();
        }
    }, 120_000);
});
