// ABOUTME: Vault partitioning, authorization, encryption, and one-use login flow invariants.
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryHandleRegistry, principalFromCredential } from '../../src/core/registry.js';
import { VaultCipher } from '../../src/core/vault/crypto.js';
import { BrowserVault } from '../../src/core/vault/service.js';
import {
    type EncryptedLogin,
    formTarget,
    type SecureForm,
    type VaultIdentity,
    type VaultProof,
    type VaultStore,
} from '../../src/core/vault/types.js';

const root = Buffer.alloc(32, 7).toString('base64');
const alice = { planet: 'sampel-palnet', moon: 'pinser-botter-sampel-palnet' };
const sibling = { ...alice, moon: 'worlet-samtes-sampel-palnet' };
const other = { planet: 'sampel-sampel', moon: 'pinser-botter-sampel-sampel' };
const pair = (identity: VaultIdentity) => JSON.stringify([identity.planet, identity.moon]);
const owner = (identity: VaultIdentity) => `owner-${identity.planet}`;
const browserKey = (identity: VaultIdentity) => `browser-${identity.moon}`;
const form = (): SecureForm => ({
    formId: 'login-form',
    pageId: 'page-1',
    frameUrl: 'https://login.example/signin',
    origin: 'https://login.example',
    kind: 'login',
    vaultEligible: true,
    fields: [
        { id: 'f0', purpose: 'username', label: 'Email', inputType: 'email', required: true },
        { id: 'f1', purpose: 'current-password', label: 'Password', inputType: 'password', required: true },
    ],
});
const secret = { username: 'private@example.test', password: 'fixture-password-secret', label: 'Personal' };
const values = { f0: secret.username, f1: secret.password };

class Store implements VaultStore {
    records = new Map<string, EncryptedLogin[]>();
    browserKeys = new Map([alice, sibling, other].map(identity => [pair(identity), browserKey(identity)]));
    ownerTokens = new Map([alice, other].map(identity => [identity.planet, owner(identity)]));
    failWrite = false;
    async verify(identity: VaultIdentity, proof: VaultProof) {
        const expected =
            proof.kind === 'browser' ? this.browserKeys.get(pair(identity)) : this.ownerTokens.get(identity.planet);
        if (!expected || expected !== (proof.kind === 'browser' ? proof.key : proof.token)) throw new Error('Denied');
    }
    async list(identity: VaultIdentity, proof: VaultProof) {
        await this.verify(identity, proof);
        return this.records.get(pair(identity)) ?? [];
    }
    async put(identity: VaultIdentity, proof: VaultProof, record: EncryptedLogin, revision: number | null) {
        await this.verify(identity, proof);
        if (proof.kind !== 'owner' || this.failWrite) throw new Error('No writes');
        const records = this.records.get(pair(identity)) ?? [];
        const current = records.find(candidate => candidate.id === record.id);
        if ((current?.revision ?? null) !== revision) throw new Error('Conflict');
        this.records.set(pair(identity), [...records.filter(candidate => candidate.id !== record.id), record]);
    }
    async delete(identity: VaultIdentity, proof: VaultProof, id: string, revision: number) {
        await this.verify(identity, proof);
        if (proof.kind !== 'owner') throw new Error('Denied');
        const records = this.records.get(pair(identity)) ?? [];
        if (!records.some(record => record.id === id && record.revision === revision)) throw new Error('Conflict');
        this.records.set(
            pair(identity),
            records.filter(record => record.id !== id)
        );
    }
}

function fixture() {
    let now = Date.now();
    const store = new Store();
    const cipher = new VaultCipher(root, 'primary');
    const registry = new InMemoryHandleRegistry({ releaseSteelSession: async () => {} });
    let page: SecureForm | null = form();
    let rejectFill = false;
    let beforeFill = async () => {};
    const fills: { sessionId: string; values: Record<string, string> }[] = [];
    const vault = new BrowserVault({
        cipher,
        store,
        registry,
        now: () => now,
        browser: {
            discover: async () => page,
            fill: async (sessionId, target, submittedValues, submit) => {
                await beforeFill();
                if (rejectFill || !page || target.formId !== page.formId) throw new Error('Form changed');
                fills.push({ sessionId, values: submittedValues });
                return { submitted: submit };
            },
        },
    });
    const session = async (identity = alice, key = store.browserKeys.get(pair(identity))!) => {
        const record = await registry.create({
            principal: principalFromCredential(key),
            steelSessionId: randomUUID(),
            expiresAt: now + 1_800_000,
        });
        expect(await vault.bindSession(record, identity, key)).toBe(true);
        return record;
    };
    const handoff = async (record: Awaited<ReturnType<typeof session>>, identity = alice, token = owner(identity)) => {
        const handoffId = randomBytes(32).toString('base64url');
        expect(await vault.prepare(record.steelSessionId, handoffId, formTarget(page!), now + 300_000)).toEqual({
            available: true,
            ...identity,
        });
        const authorization = await vault.authorize(handoffId, identity.planet, token);
        return { handoffId, ...authorization };
    };
    const seed = (identity = alice, data = secret) => {
        const record = cipher.encrypt(
            { ...identity, id: randomUUID(), origin: form().origin, revision: 1, createdAt: now, updatedAt: now },
            data
        );
        store.records.set(pair(identity), [...(store.records.get(pair(identity)) ?? []), record]);
        return record;
    };
    return {
        vault,
        store,
        cipher,
        registry,
        fills,
        session,
        handoff,
        seed,
        page: (next: SecureForm | null) => {
            page = next;
        },
        rejectFill: () => {
            rejectFill = true;
        },
        beforeFill: (action: () => Promise<void>) => {
            beforeFill = action;
        },
        advance: (ms: number) => {
            now += ms;
        },
    };
}

describe('vault cipher', () => {
    it('encrypts with fresh nonces and authenticates every scope and metadata field', () => {
        const f = fixture();
        const record = f.seed();
        expect(f.cipher.decrypt(alice, record)).toEqual(secret);
        expect(JSON.stringify(record)).not.toContain(secret.password);
        expect(JSON.stringify(record)).not.toContain(secret.username);
        expect(f.seed().nonce).not.toBe(record.nonce);
        for (const mutation of [
            { planet: other.planet },
            { moon: sibling.moon },
            { id: randomUUID() },
            { origin: 'https://elsewhere.example' },
            { revision: 2 },
            { createdAt: 1 },
            { updatedAt: 2 },
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

    it('saves only ciphertext, privately fills it in a fresh session, and blocks automatic retry', async () => {
        const first = await f.session();
        const auth = await f.handoff(first);
        expect(auth.accounts).toEqual([]);
        const saved = await f.vault.fill({ ...auth, values, submit: true, save: {} });
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
        expect(await f.vault.bindSession(record, sibling, browserKey(alice))).toBe(false);
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
