// ABOUTME: Vault partitioning, authorization, encryption, and one-use login flow invariants.
// ABOUTME: In-memory ship storage and private-browser boundaries exercise authorization and revisions.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { InMemoryHandleRegistry, principalFromCredential } from '../../src/core/registry.js';
import { VaultCipher } from '../../src/core/vault/crypto.js';
import { BrowserVault } from '../../src/core/vault/service.js';
import {
    type EncryptedLogin,
    formTarget,
    type SecureForm,
    type VaultBrowser,
    type VaultIdentity,
    type VaultProof,
    type VaultStore,
} from '../../src/core/vault/types.js';

export const root = Buffer.alloc(32, 7).toString('base64');
export const alice = { planet: 'sampel-palnet', moon: 'pinser-botter-sampel-palnet' };
export const sibling = { ...alice, moon: 'worlet-samtes-sampel-palnet' };
export const other = { planet: 'sampel-sampel', moon: 'pinser-botter-sampel-sampel' };
export const pair = (identity: VaultIdentity) => JSON.stringify([identity.planet, identity.moon]);
export const owner = (identity: VaultIdentity) => `owner-${identity.planet}`;
export const browserKey = (identity: VaultIdentity) => `browser-${identity.moon}`;
export const form = (): SecureForm => ({
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
export const secret = { username: 'private@example.test', password: 'fixture-password-secret', label: 'Personal' };
export const values = { f0: secret.username, f1: secret.password };

class Store implements VaultStore {
    records = new Map<string, EncryptedLogin[]>();
    browserKeys = new Map([alice, sibling, other].map(identity => [pair(identity), browserKey(identity)]));
    ownerTokens = new Map([alice, other].map(identity => [identity.planet, owner(identity)]));
    failWrite = false;
    async factor(identity: VaultIdentity, proof: VaultProof) {
        await this.verify(identity, proof);
        if (proof.kind !== 'owner') throw new Error('Denied');
        return Buffer.alloc(32, 9).toString('base64');
    }
    async permission(
        identity: VaultIdentity,
        proof: VaultProof,
        id: string,
        revision: number,
        permission: 'ask' | 'allow'
    ) {
        const records = await this.list(identity, proof);
        const record = records.find(r => r.id === id && r.revision === revision);
        if (!record) throw new Error('Conflict');
        await this.put(identity, proof, { ...record, revision: revision + 1, permission }, revision);
    }
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

export function fixture(browser?: VaultBrowser) {
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
        browser: browser ?? {
            discover: async () => page,
            getBound: async (_sessionId, formId) => (page?.formId === formId ? page : null),
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
            {
                ...identity,
                id: randomUUID(),
                origin: form().origin,
                revision: 1,
                createdAt: now,
                updatedAt: now,
                label: data.label,
                permission: 'allow',
                factor: Buffer.alloc(32, 9).toString('base64'),
            },
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
