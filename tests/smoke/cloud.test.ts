// ABOUTME: Smoke tests against the real Steel Cloud API, pinning the contract facts the rest of the
// ABOUTME: suite can only assert against injected fakes or the self-hosted image.
import { afterAll, describe, expect, it } from 'vitest';
import { buildCdpUrl, loadConfig } from '../../src/core/config.js';
import { CdpConnection } from '../../src/core/steel/cdp.js';
import { SteelRestClient } from '../../src/core/steel/rest.js';

const apiKey = process.env.STEEL_API_KEY?.trim();

/**
 * A page that is stable, small, and safe to hit repeatedly. Steel's own site rather than a third
 * party, so a smoke failure means Steel is broken rather than someone else's page changed.
 */
const TARGET = 'https://steel.dev/';

if (!apiKey) {
    // Vitest does not name a skipped file at default verbosity, and a silent skip here reads as
    // "cloud is verified" when nothing ran at all.
    process.stderr.write(
        '\n[smoke] SKIPPED: STEEL_API_KEY is not set, so no Steel Cloud call was made.\n' +
            '[smoke] Cloud-only surfaces stay covered by injected fakes only.\n' +
            '[smoke] Run with: STEEL_API_KEY=ste-... npm run test:smoke\n\n'
    );
}

const cloud = apiKey ? describe : describe.skip;

/** Sessions this file created, released in afterAll even when an assertion throws. */
const created: string[] = [];

cloud('Steel Cloud contract', () => {
    const config = loadConfig({ STEEL_API_KEY: apiKey });
    const api = new SteelRestClient(config);

    afterAll(async () => {
        for (const id of created) {
            // Release is idempotent, and leaving a billed browser running is the one outcome this
            // whole design exists to prevent.
            await api.releaseSession(id).catch(error => {
                process.stderr.write(`[smoke] could not release a test session: ${String(error)}\n`);
            });
        }
    });

    it('resolves the deployment as cloud and authenticates with a bearer key', () => {
        expect(config.deployment).toBe('cloud');
        expect(config.baseUrl).toBe('https://api.steel.dev');
    });

    it('reports plan limits, which the session timeout is derived from', async () => {
        const details = await api.getDetails();

        // PLAN.md derives the hard timeout from this rather than hardcoding 15/60 minutes.
        expect(details).toBeTruthy();
        expect(typeof details.maxSessionDuration === 'number' || details.maxSessionDuration === undefined).toBe(true);
        process.stderr.write(
            `[smoke] plan=${String(details.plan)} maxSessionDuration=${String(details.maxSessionDuration)} ` +
                `concurrencyLimit=${String(details.concurrencyLimit)}\n`
        );
    });

    it('scrapes with a singular `format` taking an array, and always returns links and metadata', async () => {
        const response = await api.scrape({ url: TARGET, format: ['markdown'] });

        // RESEARCH.md §2.2: the parameter is `format` (singular name, array value), `links` is not a
        // format value, and links plus metadata come back on every response.
        expect(typeof response.content.markdown).toBe('string');
        expect(String(response.content.markdown).length).toBeGreaterThan(0);
        expect(Array.isArray(response.links)).toBe(true);
        expect(response.metadata).toBeTruthy();
        expect(response.metadata.statusCode).toBe(200);
    });

    it('answers a screenshot request with a hosted file URL, not bytes', async () => {
        const response = await api.screenshot({ url: TARGET });

        // Steel Cloud returns a hosted URL; self-hosted Steel returns the bytes directly.
        expect(response.kind).toBe('hosted');
        if (response.kind !== 'hosted') throw new Error('Steel Cloud returned screenshot bytes');
        expect(response.url).toMatch(/^https?:\/\//);

        const head = await fetch(response.url, { method: 'HEAD' });
        expect(head.ok).toBe(true);
        expect(head.headers.get('content-type')).toMatch(/image\//);
    });

    it('creates a session at a client-minted id, drives it over CDP, and releases it', async () => {
        const details = await api.getDetails();
        const planMax = details.maxSessionDuration ?? 900_000;
        const timeout = Math.min(60_000, planMax);

        const sessionId = crypto.randomUUID();
        created.push(sessionId);

        const session = await api.createSession({
            sessionId,
            timeout,
            // Strictly below `timeout`, or Steel treats it as inert.
            inactivityTimeout: Math.floor(timeout / 2),
        });

        // We chose the id before the call, so a crash mid-create still leaves a sweepable handle.
        expect(session.id).toBe(sessionId);

        const url = buildCdpUrl(config, sessionId);
        // The CDP URL must carry both the key and the session id; omitting the id makes Steel start
        // a fresh billed session nothing in this process knows about.
        expect(url).toContain(`sessionId=${sessionId}`);
        expect(url).toContain('apiKey=');

        const connection = await CdpConnection.connect(url);
        try {
            const version = await connection.send<{ product?: string }>('Browser.getVersion');
            expect(String(version.product)).toMatch(/Chrome|Chromium|HeadlessChrome/i);
        } finally {
            await connection.close();
        }

        await api.releaseSession(sessionId);
        created.splice(created.indexOf(sessionId), 1);

        // Release is idempotent: the reaper and an explicit call can both land on the same session.
        await expect(api.releaseSession(sessionId)).resolves.not.toThrow();
    });

    const retention = process.env.STEEL_SMOKE_RETENTION === 'true' ? it : it.skip;
    retention(
        'keeps a quiet session beyond the old two-minute idle window',
        async () => {
            const details = await api.getDetails();
            const hard = Math.min(900_000, details.maxSessionDuration ?? 900_000);
            expect(hard, 'account hard maximum cannot prove the approved retention window').toBeGreaterThan(600_000);
            const sessionId = crypto.randomUUID();
            created.push(sessionId);
            await api.createSession({ sessionId, timeout: hard, inactivityTimeout: 600_000 });
            await new Promise(resolve => setTimeout(resolve, 540_000));
            const session = await api.getSession(sessionId);
            expect(session.status).toBe('live');
            await api.releaseSession(sessionId);
            created.splice(created.indexOf(sessionId), 1);
        },
        600_000
    );
});
