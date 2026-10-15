// ABOUTME: Real Chrome reflects a privately filled password into page text and accessible names.
// ABOUTME: MCP redacts those values, gates raw output, and refuses unrecovered sessions.
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
import { fixture, secret } from '../helpers/vault.js';

const binary = findChrome();
announceMissing('Saved-login output protection', binary ? [] : ['Chrome']);

describe.skipIf(!binary)('saved-login output in Chrome', () => {
    it('keeps a filled password out of MCP output even when the page copies it', async () => {
        const browser = await HeadlessChrome.launch(binary!);
        const site = createServer((_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end('<title>Login</title><input type="password"><div id="echo"></div><button>Continue</button>');
        });
        const pool = new CdpSessionPool(loadConfig({ STEEL_LOCAL: 'true' }), 1, () =>
            CdpConnection.connect(browser.debuggerUrl)
        );
        const f = fixture();
        const record = await f.session();
        const saved = f.seed();
        const deps = testDeps({ env: { STEEL_LOCAL: 'true' }, pool, registry: f.registry });
        deps.principal = record.principal;
        deps.vault = {
            bindSession: async () => true,
            assertSession: record => f.vault.assertSession(record),
            hasProtectedValues: () => f.vault.hasProtectedValues(record.principal),
            redact: value => f.vault.redact(record.principal, value),
            discover: (record, signal) => f.vault.discover(record, signal),
            login: (record, signal, choice) => f.vault.login(record, signal, choice),
        };
        const server = createSteelMcpServer(deps);
        const client = new Client({ name: 'vault-output', version: '1' });
        let control: CdpConnection | undefined;
        try {
            await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
            const address = site.address();
            if (!address || typeof address === 'string') throw new Error('No fixture listener');
            const page = await pool.page(record.steelSessionId);
            await page.navigate(`http://127.0.0.1:${address.port}/`);
            control = await CdpConnection.connect(browser.debuggerUrl);
            const driver = await control.attachToPage();
            f.beforeFill(async () => {
                await driver.send('Runtime.evaluate', {
                    expression: `document.querySelector('input').value = ${JSON.stringify(secret.password)};
                        document.querySelector('#echo').textContent = document.querySelector('input').value;
                        document.querySelector('button').setAttribute('aria-label', document.querySelector('input').value);`,
                });
            });
            const [ct, st] = InMemoryTransport.createLinkedPair();
            await server.connect(st);
            await client.connect(ct);
            const listed = await client.callTool({
                name: 'browser_login',
                arguments: { session_id: record.handle, action: 'list' },
            });
            expect(JSON.stringify(listed)).toContain(saved.id);
            expect(JSON.stringify(listed)).not.toContain(secret.password);
            const filled = await client.callTool({ name: 'browser_login', arguments: { session_id: record.handle } });
            expect(filled.structuredContent).toMatchObject({ login: { status: 'filled' } });
            expect((await page.snapshot({ interactiveOnly: false })).text).toContain(secret.password);
            const snapshot = await client.callTool({
                name: 'browser_snapshot',
                arguments: { session_id: record.handle },
            });
            expect(snapshot.isError).not.toBe(true);
            expect(JSON.stringify(snapshot)).not.toContain(secret.password);
            expect(JSON.stringify(snapshot)).toContain('[redacted]');
            for (const name of ['browser_screenshot', 'browser_session_live_view', 'browser_session_diagnostics']) {
                const result = await client.callTool({ name, arguments: { session_id: record.handle } });
                expect(result.isError).toBe(true);
                expect(JSON.stringify(result)).not.toContain(secret.password);
            }
            f.vault.forgetSession(record.steelSessionId);
            const stale = await client.callTool({ name: 'browser_snapshot', arguments: { session_id: record.handle } });
            expect(stale.isError).toBe(true);
            expect(JSON.stringify(stale)).not.toContain(secret.password);
        } finally {
            await client.close();
            await server.close();
            await control?.close();
            await pool.closeAll();
            site.closeAllConnections();
            if (site.listening) await new Promise<void>(resolve => site.close(() => resolve()));
            await browser.close();
        }
    });
});
