// ABOUTME: Vault partitioning, authorization, encryption, and one-use login flow invariants.
// ABOUTME: Credential use requires current consent and never returns decrypted secrets.
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VaultCipher } from '../../src/core/vault/crypto.js';
import { formTarget } from '../../src/core/vault/types.js';
import { alice, browserKey, fixture, form, other, owner, pair, secret, sibling, values } from '../helpers/vault.js';

describe('vault cipher', () => {
    it('encrypts with fresh nonces and authenticates every scope and metadata field', () => {
        const f = fixture();
        const record = f.seed();
        expect(f.cipher.decrypt(alice, record)).toEqual(secret);
        expect(JSON.stringify(record)).not.toContain(secret.password);
        expect(record).toHaveProperty('username', secret.username);
        expect(f.seed().nonce).not.toBe(record.nonce);
        for (const mutation of [
            { planet: other.planet },
            { moon: sibling.moon },
            { id: randomUUID() },
            { origin: 'https://elsewhere.example' },
            { createdAt: 1 },
            { label: 'Other' },
            { username: 'other@example.com' },
            { username: undefined },
            { factor: Buffer.alloc(32, 10).toString('base64') },
            { keyId: 'different' },
            { tag: Buffer.alloc(16).toString('base64') },
            { nonce: Buffer.alloc(12).toString('base64') },
            { ciphertext: Buffer.from('different').toString('base64') },
        ]) {
            expect(() => f.cipher.decrypt(alice, { ...record, ...mutation })).toThrow('could not be decrypted');
        }
        expect(() => f.cipher.decrypt(sibling, record)).toThrow();
        expect(() =>
            new VaultCipher(Buffer.alloc(32, 8).toString('base64'), 'primary').decrypt(alice, record)
        ).toThrow();
        expect(() => new VaultCipher('', 'primary')).toThrow();
    });
});

describe('planet-backed browser vault', () => {
    let f: ReturnType<typeof fixture>;
    beforeEach(() => {
        f = fixture();
    });

    it('discovers metadata without decrypting and asks before using an unapproved credential', async () => {
        const saved = f.seed();
        f.store.records.set(pair(alice), [{ ...saved, permission: 'ask' }]);
        const record = await f.session();
        const before = f.cipher.decrypt;
        f.cipher.decrypt = () => {
            throw new Error('Discovery must not decrypt');
        };
        expect(await f.vault.discover(record)).toEqual([
            {
                id: saved.id,
                origin: saved.origin,
                revision: saved.revision,
                updatedAt: saved.updatedAt,
                label: 'Personal',
                username: secret.username,
                permission: 'ask',
            },
        ]);
        expect(await f.vault.login(record, undefined, { id: saved.id, revision: saved.revision })).toEqual({
            status: 'approval_required',
        });
        expect(f.fills).toEqual([]);
        f.cipher.decrypt = before;
    });

    it('allows one owner fill without granting subsequent automatic use', async () => {
        const saved = f.seed();
        f.store.records.set(pair(alice), [{ ...saved, permission: 'ask' }]);
        const record = await f.session();
        const auth = await f.handoff(record);
        await f.vault.fill({ ...auth, submit: true, use: { id: saved.id, revision: 1 } });
        expect(f.fills).toHaveLength(1);
        expect(await f.vault.login(await f.session())).toEqual({ status: 'approval_required' });
    });

    it('saves automatic use only on explicit consent and honors revocation', async () => {
        const record = await f.session();
        const auth = await f.handoff(record);
        await f.vault.fill({ ...auth, values, submit: true, save: { permission: 'ask' } });
        const saved = f.store.records.get(pair(alice))![0]!;
        expect(saved.permission).toBe('ask');
        await f.vault.setPermission(alice, owner(alice), { id: saved.id, revision: 1 }, 'allow');
        expect(await f.vault.login(await f.session())).toMatchObject({ status: 'filled' });
        await f.vault.setPermission(alice, owner(alice), { id: saved.id, revision: 2 }, 'ask');
        expect(await f.vault.login(await f.session())).toEqual({ status: 'approval_required' });
    });

    it('protects known values in model-visible text independently of DOM attributes', async () => {
        f.seed();
        const record = await f.session();
        await f.vault.login(record);
        const result = {
            content: [{ type: 'text', text: `Accessible label ${secret.password}` }],
            structuredContent: {
                url: `https://login.example/${encodeURIComponent(secret.password)}`,
                title: Buffer.from(secret.password).toString('base64'),
            },
        };
        expect(JSON.stringify(f.vault.redact(record.principal, result))).not.toContain(secret.password);
        expect(f.vault.redact(record.principal, result).structuredContent.title).toBe('[redacted]');
        expect(f.vault.hasProtectedValues(record.principal)).toBe(true);
        expect(f.vault.redact('another-principal', result)).toEqual(result);
    });

    it('saves only ciphertext, privately fills it in a fresh session, and blocks automatic retry', async () => {
        const first = await f.session();
        const auth = await f.handoff(first);
        expect(auth.accounts).toEqual([]);
        const saved = await f.vault.fill({ ...auth, values, submit: true, save: { permission: 'allow' } });
        expect(saved).toEqual({ ok: true, submitted: true, saveStatus: 'saved' });
        expect(await f.vault.login(first)).toEqual({ status: 'needs_input' });
        const second = await f.session();
        const outcome = await f.vault.login(second);
        expect(outcome).toEqual({ status: 'filled', submission_attempted: true });
        expect(f.fills.at(-1)).toEqual({ sessionId: second.steelSessionId, values });
        expect(JSON.stringify([saved, outcome, [...f.store.records.values()]])).not.toContain(secret.password);
        expect(await f.vault.login(second)).toEqual({ status: 'needs_input' });
        expect(f.fills).toHaveLength(2);
    });

    it('keeps two moons and two planets isolated and rejects forged routing hints', async () => {
        f.seed();
        const record = await f.session();
        await expect(f.vault.bindSession(record, sibling, browserKey(alice))).rejects.toThrow(
            'verification is unavailable'
        );
        for (const identity of [sibling, other]) {
            const unrelated = await f.session(identity);
            expect(await f.vault.login(unrelated)).toEqual({ status: 'no_match' });
            expect(await f.vault.list(identity, owner(identity))).toEqual([]);
        }
        await expect(f.vault.list(alice, owner(other))).rejects.toThrow();
        const id = randomBytes(32).toString('base64url');
        await f.vault.prepare(record.steelSessionId, id, formTarget(form()), Date.now() + 60_000);
        await expect(f.vault.authorize(id, other.planet, owner(other))).rejects.toThrow('another planet');
        await expect(
            f.vault.fill({ handoffId: id, grant: 'x'.repeat(43), values, submit: true, save: {} })
        ).rejects.toThrow();
        expect(f.fills).toEqual([]);
    });

    it('requires owner selection for ambiguity without returning accounts to the agent', async () => {
        const chosen = f.seed();
        f.seed(alice, { ...secret, label: 'Work', password: 'work-secret' });
        const record = await f.session();
        expect(await f.vault.login(record)).toEqual({ status: 'choice_required' });
        const auth = await f.handoff(record);
        expect(auth.accounts.map(account => account.label)).toEqual(['Personal', 'Work']);
        expect(JSON.stringify(auth)).not.toContain(secret.password);
        await f.vault.fill({ ...auth, submit: true, use: { id: chosen.id, revision: 1 } });
        expect(f.fills.at(-1)?.values).toEqual(values);
        expect(await f.vault.login(record)).toEqual({ status: 'needs_input' });
    });

    it('consumes grants before fills, including failures, and expires handoffs', async () => {
        const record = await f.session();
        const auth = await f.handoff(record);
        f.rejectFill();
        const input = { ...auth, values, submit: true, save: {} };
        await expect(f.vault.fill(input)).rejects.toThrow('Form changed');
        await expect(f.vault.fill(input)).rejects.toThrow('already used');
        expect(f.store.records.size).toBe(0);
        const expiring = await f.handoff(record);
        f.advance(300_001);
        await expect(f.vault.fill({ ...expiring, values, submit: true, save: {} })).rejects.toThrow('expired');
    });

    it('survives browser-key and owner-token rotation without preserving stale authorization', async () => {
        f.seed();
        const stale = await f.session();
        const auth = await f.handoff(stale);
        f.store.ownerTokens.set(alice.planet, 'new-owner');
        await expect(f.vault.fill({ ...auth, values, submit: true, save: {} })).rejects.toThrow('Denied');
        f.store.browserKeys.set(pair(alice), 'new-browser-key');
        await expect(f.vault.login(stale)).rejects.toThrow('Denied');
        const current = await f.session();
        expect(await f.vault.login(current)).toEqual({ status: 'filled', submission_attempted: true });
        expect(await f.vault.list(alice, 'new-owner')).toHaveLength(1);
        expect(f.fills.at(-1)?.values).toEqual(values);
    });

    it('saves username-first flows only after the accepted password step and explicit continued consent', async () => {
        const record = await f.session();
        f.page({ ...form(), fields: [form().fields[0]!] });
        const first = await f.handoff(record);
        expect(
            await f.vault.fill({ ...first, values: { f0: secret.username }, submit: true, save: { label: 'Personal' } })
        ).toMatchObject({ saveStatus: 'pending' });
        expect(f.store.records.size).toBe(0);
        f.page({ ...form(), formId: 'password-step', fields: [form().fields[1]!] });
        const second = await f.handoff(record);
        expect(
            await f.vault.fill({ ...second, values: { f1: secret.password }, submit: true, save: {} })
        ).toMatchObject({ saveStatus: 'saved' });
        expect(f.cipher.decrypt(alice, f.store.records.get(pair(alice))![0]!)).toEqual(secret);
    });

    it('does not overwrite a pending update when the owner explicitly chooses a new login', async () => {
        const saved = f.seed();
        const record = await f.session();
        f.page({ ...form(), fields: [form().fields[0]!] });
        const first = await f.handoff(record);
        await f.vault.fill({
            ...first,
            values: { f0: secret.username },
            submit: true,
            save: { update: { id: saved.id, revision: 1 } },
        });
        f.page({ ...form(), formId: 'password-step', fields: [form().fields[1]!] });
        const next = await f.handoff(record);
        await f.vault.fill({ ...next, values: { f1: 'new-secret' }, submit: true, save: { label: 'New login' } });
        expect(f.store.records.get(pair(alice))).toHaveLength(2);
        expect(f.store.records.get(pair(alice))?.find(entry => entry.id === saved.id)?.revision).toBe(1);
    });

    it('clears canceled username flows and does not restore them from an in-flight fill', async () => {
        const record = await f.session();
        f.page({ ...form(), fields: [form().fields[0]!] });
        const first = await f.handoff(record);
        let entered!: () => void;
        let finish!: () => void;
        const started = new Promise<void>(resolve => {
            entered = resolve;
        });
        f.beforeFill(
            () =>
                new Promise<void>(resolve => {
                    finish = resolve;
                    entered();
                })
        );
        const pending = f.vault.fill({ ...first, values: { f0: secret.username }, submit: true, save: {} });
        await started;
        f.vault.cancelSessionFlow(record.steelSessionId);
        finish();
        expect(await pending).toMatchObject({ saveStatus: 'failed' });
        f.beforeFill(async () => {});
        f.page({ ...form(), formId: 'password-step', fields: [form().fields[1]!] });
        const next = await f.handoff(record);
        await expect(
            f.vault.fill({ ...next, values: { f1: secret.password }, submit: true, save: {} })
        ).rejects.toThrow('account label');
        expect(f.store.records.size).toBe(0);
        const canceled = await f.handoff(record);
        f.vault.cancelSessionFlow(record.steelSessionId);
        await expect(
            f.vault.fill({ ...canceled, values: { f1: secret.password }, submit: true, save: { label: 'Personal' } })
        ).rejects.toThrow('already used');
    });

    it('refuses malformed internationalized origins before preparing a save', async () => {
        const record = await f.session();
        const invalid = { ...form(), origin: 'https://xn--', frameUrl: 'https://xn--/login' };
        f.page(invalid);
        const handoffId = randomBytes(32).toString('base64url');
        expect(
            await f.vault.prepare(record.steelSessionId, handoffId, formTarget(invalid), Date.now() + 60_000)
        ).toEqual({ available: false });
        await expect(f.vault.authorize(handoffId, alice.planet, owner(alice))).rejects.toThrow('invalid');
        expect(f.store.records.size).toBe(0);
        expect(f.fills).toEqual([]);
    });

    it('reports save failure separately from fill success and rejects unsafe or OTP forms', async () => {
        const record = await f.session();
        const auth = await f.handoff(record);
        f.store.failWrite = true;
        expect(await f.vault.fill({ ...auth, values, submit: true, save: {} })).toEqual({
            ok: true,
            submitted: true,
            saveStatus: 'failed',
        });
        expect(f.fills).toHaveLength(1);
        for (const unsafe of [
            { ...form(), vaultEligible: false },
            { ...form(), origin: 'http://login.example' },
            { ...form(), fields: [{ ...form().fields[1]!, purpose: 'one-time-code' }] },
        ]) {
            f.page(unsafe);
            expect(await f.vault.login(record)).toEqual({ status: 'needs_input' });
        }
        expect(f.fills).toHaveLength(1);
    });

    it('honors deletion, revision conflicts, session release, and human control', async () => {
        const saved = f.seed();
        const record = await f.session();
        const auth = await f.handoff(record);
        await f.vault.delete(alice, owner(alice), { id: saved.id, revision: 1 });
        await expect(f.vault.fill({ ...auth, submit: true, use: { id: saved.id, revision: 1 } })).rejects.toThrow(
            'changed'
        );
        expect(await f.vault.login(record)).toEqual({ status: 'no_match' });
        f.seed();
        const control = await f.registry.acquireHumanControl(record.handle, record.principal, 60_000);
        await expect(f.vault.login(record)).rejects.toThrow('human control');
        await f.registry.releaseHumanControl(record.handle, record.principal, control.token);
        await f.registry.release(record.handle, record.principal, 'explicit');
        await expect(f.vault.login(record)).rejects.toThrow('unavailable');
        expect(f.fills).toEqual([]);
    });
});
