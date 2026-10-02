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
announceMissing('Credential continuation', binary ? [] : ['Chrome']);

describe.skipIf(!binary)('credential continuation in a real browser', () => {
    it.each(['account', 'challenge'] as const)('continues a filled form until the page shows %s', async outcome => {
        const browser = await HeadlessChrome.launch(binary!);
        const site = createServer((_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(`<h1>Sign in</h1><form onsubmit="event.preventDefault()">
                <label>Password<input type="password" autocomplete="current-password" value="fixture-private-secret"></label>
                <button type="button" onclick="if(event.isTrusted){${
                    outcome === 'account'
                        ? "document.body.innerHTML='<h1>Account home</h1><button>Sign out</button>'"
                        : "document.body.insertAdjacentHTML('beforeend', '<iframe title=&quot;Widget containing a Cloudflare security challenge&quot;></iframe><p>Please complete the security check to continue.</p>')"
                }}">Sign in</button>
                </form><form action="https://other.test"><button>Continue</button></form>`);
        });
        const env = { STEEL_LOCAL: 'true', OPENROUTER_API_KEY: 'test-only-key' };
        const pool = new CdpSessionPool(loadConfig(env), 1, () => CdpConnection.connect(browser.debuggerUrl));
        let client: Client | undefined;
        let server: ReturnType<typeof createSteelMcpServer> | undefined;
        let connection: CdpConnection | undefined;
        try {
            await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
            const address = site.address();
            if (!address || typeof address === 'string') throw new Error('No fixture listener');
            const origin = `http://127.0.0.1:${address.port}`;
            const page = await pool.page('existing-browser');
            await page.navigate(`${origin}/login`);
            connection = await CdpConnection.connect(browser.debuggerUrl);
            const driver = await connection.attachToPage();
            const target = await driver.send<{ targetInfo: { targetId: string } }>('Target.getTargetInfo');
            const receipt = {
                pageId: target.targetInfo.targetId,
                frameUrl: `${origin}/login`,
                origin,
                kind: 'password' as const,
                expiresAt: Date.now() + 60_000,
                submissionAttempted: false,
            };
            expect(await page.matchesCredentialContinuation(receipt)).toBe(true);
            expect(await page.matchesCredentialContinuation({ ...receipt, pageId: 'other-target' })).toBe(false);
            expect(await page.matchesCredentialContinuation({ ...receipt, origin: 'https://other.test' })).toBe(false);
            const initial = await page.snapshot({ interactiveOnly: false });
            const unrelated = initial.nodes.find(node => node.name === 'Continue')!;
            expect(await page.isCredentialControl(unrelated.ref!, 'password')).toBe(false);
            const deps = testDeps({ env, pool });
            deps.api.getCredentialContinuation = async () => {
                const current = await driver.send<{ result: { value: boolean } }>('Runtime.evaluate', {
                    expression: 'Boolean(document.querySelector("input[type=password]"))',
                    returnByValue: true,
                });
                return current.result.value ? receipt : null;
            };
            const modelInputs: string[] = [];
            deps.jevFetch = async (_url, init) => {
                const input = String(init?.body);
                modelInputs.push(input);
                const body = JSON.parse(input);
                const done = String(body.state.page).includes('Account home');
                const action = done
                    ? 'done'
                    : Object.entries(body.questions.action.criteria).find(
                          ([, label]) => label === 'Click button Sign in'
                      )?.[0];
                expect(action).toBeTruthy();
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
            client = new Client({ name: 'credential-test', version: '1' });
            const [ct, st] = InMemoryTransport.createLinkedPair();
            await server.connect(st);
            await client.connect(ct);
            const snapshot = await client.callTool({
                name: 'browser_snapshot',
                arguments: { session_id: record.handle },
            });
            expect(snapshot.structuredContent).toMatchObject({
                credential_state: 'filled',
                submission_attempted: false,
            });
            const result = await client.callTool({
                name: 'browser_run',
                arguments: {
                    session_id: record.handle,
                    task: 'Finish signing in and verify that Account home appears',
                },
            });
            expect(result.structuredContent).toMatchObject({
                status: outcome === 'account' ? 'done' : 'needs_handoff',
                usage: { calls: outcome === 'account' ? 2 : 1 },
            });
            expect(JSON.stringify(result)).toContain(outcome === 'account' ? 'Account home' : 'security check');
            if (outcome === 'challenge')
                expect(await deps.api.getCredentialContinuation('existing-browser')).toEqual(receipt);
            expect(modelInputs.join('\n')).not.toContain('fixture-private-secret');
            expect(JSON.stringify(snapshot)).not.toContain('fixture-private-secret');
            expect(deps.api.created).toHaveLength(0);
        } finally {
            await client?.close();
            await server?.close();
            await connection?.close();
            await pool.closeAll();
            site.closeAllConnections();
            if (site.listening) await new Promise<void>(resolve => site.close(() => resolve()));
            await browser.close();
        }
    });
});
