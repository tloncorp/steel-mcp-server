// ABOUTME: Verifies browser artifacts are downloadable only through their short-lived signed URL.
import { describe, expect, it } from 'vitest';
import { createHostedArtifactService } from '../../src/core/artifacts.js';

const SECRET = 'artifact-test-secret-that-is-at-least-thirty-two-bytes';

describe('hosted browser artifacts', () => {
    it('returns a fetchable capability URL without exposing a listing endpoint', async () => {
        const service = createHostedArtifactService({
            BROWSER_ARTIFACT_PUBLIC_ORIGIN: 'https://browser-session.test',
            BROWSER_ARTIFACT_SIGNING_KEY: SECRET,
            BROWSER_ARTIFACT_HOST: '127.0.0.1',
            BROWSER_ARTIFACT_PORT: '0',
        });
        expect(service).toBeDefined();
        const port = await service!.listen();
        try {
            const published = await service!.publish({
                principal: 'principal-a',
                data: Buffer.from('jpeg-bytes').toString('base64'),
                mimeType: 'image/jpeg',
                filename: 'screenshot.jpg',
            });
            expect(published.url).toMatch(/^https:\/\/browser-session\.test\/artifacts\//);
            const token = decodeURIComponent(new URL(published.url).pathname.split('/')[2]!);
            const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));
            expect(payload.sub).not.toBe('principal-a');
            expect(JSON.stringify(payload)).not.toContain('principal-a');

            const publicPath = new URL(published.url).pathname;
            const response = await fetch(`http://127.0.0.1:${port}${publicPath}`);
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('image/jpeg');
            expect(response.headers.get('cache-control')).toContain('no-store');
            expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('jpeg-bytes');

            const listing = await fetch(`http://127.0.0.1:${port}/artifacts`);
            expect(listing.status).toBe(404);
        } finally {
            await service!.close();
        }
    });

    it('rejects a tampered capability', async () => {
        const service = createHostedArtifactService({
            BROWSER_ARTIFACT_PUBLIC_ORIGIN: 'https://browser-session.test',
            BROWSER_ARTIFACT_SIGNING_KEY: SECRET,
            BROWSER_ARTIFACT_HOST: '127.0.0.1',
            BROWSER_ARTIFACT_PORT: '0',
        })!;
        const port = await service.listen();
        try {
            const published = await service.publish({
                principal: 'principal-a',
                data: Buffer.from('jpeg-bytes').toString('base64'),
                mimeType: 'image/jpeg',
                filename: 'screenshot.jpg',
            });
            const path = new URL(published.url).pathname;
            const tampered = path.replace('/artifacts/', '/artifacts/x');
            expect((await fetch(`http://127.0.0.1:${port}${tampered}`)).status).toBe(404);
        } finally {
            await service.close();
        }
    });
});
