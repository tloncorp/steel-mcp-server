// ABOUTME: Exercises keyboard-only accessible cards through the real snapshot and action pipeline.
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { BrowserPage } from '../../src/core/page.js';
import { resolveSettleBudgets } from '../../src/core/settle.js';
import { CdpConnection } from '../../src/core/steel/cdp.js';
import { runCandidates } from '../../src/core/tools/run.js';
import { announceMissing, findChrome, HeadlessChrome } from '../helpers/headless-chrome.js';

const binary = findChrome();
announceMissing('Keyboard-only browser controls', binary ? [] : ['Chrome']);

describe.skipIf(!binary)('Keyboard-only browser controls', () => {
    it('activates the exact card with Enter and refuses overlays, disabled controls and lost focus', async () => {
        const browser = await HeadlessChrome.launch(binary!);
        const site = createServer((_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(`<!doctype html><title>Flight cards</title>
                <style>
                .card { position: relative; width: 500px; height: 100px; }
                .keyboard { position: absolute; inset: 0; pointer-events: none; }
                .visual { height: 100%; background: #eee; }
                </style>
                <h1>Results</h1>
                <div role="tablist"><button role="tab" aria-selected="true">Cheapest</button></div>
                <div class="card">
                    <div id="fare" class="keyboard" role="link" tabindex="0" aria-label="From 282 dollars. Viva at 1:55&#8239;PM to MEX.  Select flight"></div>
                    <div class="visual">Viva — 282 dollars</div>
                </div>
                <input id="other" aria-label="Other field">
                <script>
                window.activations = 0;
                document.getElementById('fare').addEventListener('keydown', event => {
                    if (event.key === 'Enter') {
                        window.activations++;
                        document.querySelector('h1').textContent = 'Selected Viva to MEX';
                    }
                });
                </script>`);
        });
        let connection: CdpConnection | undefined;
        try {
            await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
            const address = site.address();
            if (!address || typeof address === 'string') throw new Error('No listener');
            const url = `http://127.0.0.1:${address.port}/`;
            connection = await CdpConnection.connect(browser.debuggerUrl);
            const session = await connection.attachToPage();
            const page = await BrowserPage.attach(session, { budgets: resolveSettleBudgets(1) });
            await page.navigate(url);
            const snapshot = await page.snapshot({});
            const fare = snapshot.nodes.find(node => node.name.startsWith('From 282'));
            expect(fare).toMatchObject({ role: 'link', activation: 'keyboard', interactive: true });
            expect(fare?.ref).toBeTruthy();
            const actions = [...runCandidates(snapshot, []).values()];
            expect(actions.some(action => action.label === 'Click tab Cheapest')).toBe(false);
            const select = actions.find(action => action.action?.target === fare?.ref);
            expect(select?.action).toBeDefined();
            const result = await page.act(select!.action!);
            expect(result.summary).toContain('with Enter');
            expect((await page.snapshot({})).text).toContain('Selected Viva to MEX');

            const blockers = [
                `document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0;background:white;z-index:1000">Overlay</div>')`,
                `document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true">Review required</div>')`,
                `document.getElementById('fare').setAttribute('aria-disabled', 'true')`,
                `document.getElementById('fare').addEventListener('focus', () => document.getElementById('other').focus())`,
                `document.getElementById('fare').addEventListener('focus', () => document.getElementById('fare').setAttribute('aria-label', 'Purchase something else'))`,
            ];
            for (const expression of blockers) {
                await page.navigate(url);
                const fresh = await page.snapshot({});
                const target = fresh.nodes.find(node => node.name.startsWith('From 282'))!.ref!;
                await session.send('Runtime.evaluate', { expression });
                await expect(page.act({ action: 'click', target }), expression).rejects.toThrow();
                const count = await session.send<{ result: { value: number } }>('Runtime.evaluate', {
                    expression: 'window.activations',
                    returnByValue: true,
                });
                expect(count.result.value).toBe(0);
            }
        } finally {
            await connection?.close();
            site.closeAllConnections();
            if (site.listening) await new Promise<void>(resolve => site.close(() => resolve()));
            await browser.close();
        }
    }, 120_000);
});
