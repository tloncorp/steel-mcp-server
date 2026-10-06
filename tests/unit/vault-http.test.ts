// ABOUTME: The owner HTTP surface is service-authenticated, bounded, and secret-safe on errors.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadVault } from '../../src/core/vault/config.js';
import { VaultCipher } from '../../src/core/vault/crypto.js';
import { PioneerVaultStore } from '../../src/core/vault/pioneer.js';
import type { BrowserVault } from '../../src/core/vault/service.js';
import { createVaultHttp } from '../../src/vault-http.js';

const token = 'service-secret-'.repeat(4);
const identity = { planet: 'sampel-palnet', moon: 'pinser-botter-sampel-palnet' };
const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            server =>
                new Promise<void>(resolve => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                })
        )
    );
});
async function endpoint(vault: Partial<BrowserVault>) {
    const handler = createVaultHttp(vault as BrowserVault, token);
    const server = createServer((request, response) => {
        void handler(request, response);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener');
    return `http://127.0.0.1:${address.port}/internal/vault`;
}
const post = (url: string, body: unknown, service = token) =>
    fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-browser-vault-service': service },
        body: JSON.stringify(body),
    });

describe('private vault HTTP', () => {
    it('requires the service token before owner authorization and rejects oversized or extra fields', async () => {
        const list = vi.fn().mockResolvedValue([]);
        const base = await endpoint({ list });
        const body = { ...identity, ownerToken: 'owner-private' };
        expect((await post(`${base}/list`, body, 'wrong')).status).toBe(403);
        expect(list).not.toHaveBeenCalled();
        expect((await post(`${base}/list`, { ...body, password: 'never-accepted' })).status).toBe(400);
        expect((await post(`${base}/list`, { ...body, ownerToken: 'x'.repeat(70_000) })).status).toBe(413);
        expect(list).not.toHaveBeenCalled();
        const response = await post(`${base}/list`, body);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ accounts: [] });
        expect(list).toHaveBeenCalledWith(identity, 'owner-private', expect.any(AbortSignal));
    });

    it('never echoes remote exceptions, validation inputs, or owner proof', async () => {
        const base = await endpoint({
            authorize: vi.fn().mockRejectedValue(new Error('owner-private password-private')),
        });
        const response = await post(`${base}/authorize`, {
            handoffId: 'a'.repeat(43),
            planet: identity.planet,
            ownerToken: 'owner-private',
        });
        expect(response.status).toBe(503);
        expect(await response.text()).not.toMatch(/owner-private|password-private/);
        const invalid = await post(`${base}/fill`, { handoffId: 'private-password', password: 'secret' });
        expect(invalid.status).toBe(400);
        expect(await invalid.text()).not.toMatch(/private-password|secret/);
    });

    it('accepts only a single save or account selection and never exposes a generic secret retrieval', async () => {
        const fill = vi.fn().mockResolvedValue({ ok: true, submitted: true, saveStatus: 'saved' });
        const base = await endpoint({ fill });
        const input = {
            handoffId: 'a'.repeat(43),
            grant: 'g'.repeat(43),
            values: { f0: 'fixture-password' },
            submit: true,
            save: { label: 'Personal' },
        };
        expect(
            (await post(`${base}/fill`, { ...input, use: { id: '8e40b5f5-fd41-4851-8922-b9545e470d6e', revision: 1 } }))
                .status
        ).toBe(400);
        expect((await post(`${base}/get-password`, input)).status).toBe(404);
        expect(fill).not.toHaveBeenCalled();
        const response = await post(`${base}/fill`, input);
        expect(await response.json()).toEqual({ ok: true, submitted: true, saveStatus: 'saved' });
        expect(fill).toHaveBeenCalledOnce();
    });
});

describe('Pioneer vault protocol', () => {
    it('uses only the configured HTTPS planet origin and proves both identities', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(identity)));
        const store = new PioneerVaultStore('https://{planet}-feds.example', token, fetcher);
        await store.verify(identity, { kind: 'browser', key: 'fixture-derived-key' });
        const [url, options] = fetcher.mock.calls[0]!;
        expect(String(url)).toBe('https://sampel-palnet-feds.example/v1/browser-vault');
        expect(options).toMatchObject({
            redirect: 'error',
            cache: 'no-store',
            headers: { authorization: `Basic ${token}` },
        });
        expect(JSON.parse(options!.body as string)).toEqual({
            ...identity,
            proof: { kind: 'browser', key: 'fixture-derived-key' },
            operation: 'verify',
        });
        fetcher.mockResolvedValue(new Response(JSON.stringify({ ...identity, moon: 'another-moon' })));
        await expect(store.verify(identity, { kind: 'browser', key: 'fixture' })).rejects.toThrow(
            'verification failed'
        );
        expect(() => new PioneerVaultStore('http://{planet}.example', token)).toThrow();
        expect(() => new PioneerVaultStore('https://fixed.example', token)).toThrow();
    });

    it('rejects cross-moon ciphertext and requires explicit write acknowledgements', async () => {
        const cipher = new VaultCipher(Buffer.alloc(32, 7).toString('base64'), 'primary');
        const record = cipher.encrypt(
            {
                ...identity,
                id: '8e40b5f5-fd41-4851-8922-b9545e470d6e',
                origin: 'https://login.example',
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
            },
            { password: 'fixture-password', label: 'Personal' }
        );
        const fetcher = vi.fn<typeof fetch>();
        const store = new PioneerVaultStore('https://{planet}.example', token, fetcher);
        fetcher.mockResolvedValue(new Response(JSON.stringify({ records: [{ ...record, moon: 'another-moon' }] })));
        await expect(store.list(identity, { kind: 'owner', token: 'owner' })).rejects.toThrow('invalid records');
        fetcher.mockResolvedValue(new Response('{"ok":false}'));
        await expect(store.put(identity, { kind: 'owner', token: 'owner' }, record, null)).rejects.toThrow(
            'acknowledge'
        );
        fetcher.mockResolvedValue(new Response('private-password', { status: 403 }));
        await expect(store.list(identity, { kind: 'owner', token: 'owner' })).rejects.toThrow(
            'Vault authorization failed.'
        );
    });

    it('is disabled by default and refuses incomplete key configuration when enabled', () => {
        expect(loadVault({}, 'http://127.0.0.1:3000')).toBeUndefined();
        expect(() => loadVault({ BROWSER_VAULT_ENABLED: 'true' }, 'http://127.0.0.1:3000')).toThrow(
            'BROWSER_VAULT_KEY is required'
        );
    });

    it('uses the existing Pioneer token independently of the viewer service token', () => {
        const env = {
            BROWSER_VAULT_ENABLED: 'true',
            BROWSER_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
            BROWSER_VAULT_KEY_ID: 'primary',
            BROWSER_VAULT_SERVICE_TOKEN: token,
            BROWSER_VAULT_PIONEER_ORIGIN: 'https://{planet}-feds.example',
        };
        expect(() => loadVault(env, 'http://127.0.0.1:3000')).toThrow('PIONEER_SIDECAR_TOKEN is required');
        const loaded = loadVault({ ...env, PIONEER_SIDECAR_TOKEN: 'pioneer-existing-token' }, 'http://127.0.0.1:3000');
        expect(loaded?.serviceToken).toBe(token);
        expect(loaded?.create).toBeTypeOf('function');
    });
});
