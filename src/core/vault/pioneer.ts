// ABOUTME: The only vault storage connection: verified identities and ciphertext go directly to Pioneer.
import { z } from 'zod';
import { privateJson } from './transport.js';
import {
    type EncryptedLogin,
    encryptedLoginSchema,
    identitySchema,
    sameIdentity,
    VaultError,
    type VaultIdentity,
    type VaultProof,
    type VaultStore,
} from './types.js';

export class PioneerVaultStore implements VaultStore {
    constructor(
        private readonly originTemplate: string,
        private readonly serviceToken: string,
        private readonly fetchImpl = fetch
    ) {
        if (originTemplate.split('{planet}').length !== 2)
            throw new Error('BROWSER_VAULT_PIONEER_ORIGIN must contain {planet} once.');
        const example = new URL(originTemplate.replace('{planet}', 'sampel-palnet'));
        if (
            example.protocol !== 'https:' ||
            example.username ||
            example.password ||
            example.pathname !== '/' ||
            example.search ||
            example.hash ||
            serviceToken.length < 32
        ) {
            throw new Error(
                'The vault requires an HTTPS Pioneer origin template and a service token of at least 32 characters.'
            );
        }
    }

    private async request(
        identity: VaultIdentity,
        proof: VaultProof,
        operation: string,
        payload: Record<string, unknown> = {},
        signal?: AbortSignal
    ): Promise<unknown> {
        identitySchema.parse(identity);
        const url = new URL('/v1/browser-vault', this.originTemplate.replace('{planet}', identity.planet));
        return privateJson(
            url,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-browser-vault-service': this.serviceToken },
                body: JSON.stringify({ ...identity, proof, operation, ...payload }),
                signal,
            },
            this.fetchImpl
        );
    }

    async verify(identity: VaultIdentity, proof: VaultProof, signal?: AbortSignal): Promise<void> {
        const actual = identitySchema.safeParse(await this.request(identity, proof, 'verify', {}, signal));
        if (!actual.success || !sameIdentity(actual.data, identity))
            throw new VaultError(403, 'Vault identity verification failed.');
    }

    async list(identity: VaultIdentity, proof: VaultProof, signal?: AbortSignal): Promise<EncryptedLogin[]> {
        const result = z
            .object({ records: z.array(encryptedLoginSchema).max(200) })
            .safeParse(await this.request(identity, proof, 'list', {}, signal));
        if (!result.success || result.data.records.some(record => !sameIdentity(record, identity)))
            throw new VaultError(503, 'The credential store returned invalid records.');
        return result.data.records;
    }

    async put(
        identity: VaultIdentity,
        proof: VaultProof,
        record: EncryptedLogin,
        expectedRevision: number | null,
        signal?: AbortSignal
    ): Promise<void> {
        const result = await this.request(identity, proof, 'put', { record, expectedRevision }, signal);
        if (!z.object({ ok: z.literal(true) }).safeParse(result).success)
            throw new VaultError(503, 'The credential store did not acknowledge the save.');
    }

    async delete(
        identity: VaultIdentity,
        proof: VaultProof,
        id: string,
        expectedRevision: number,
        signal?: AbortSignal
    ): Promise<void> {
        const result = await this.request(identity, proof, 'delete', { id, expectedRevision }, signal);
        if (!z.object({ ok: z.literal(true) }).safeParse(result).success)
            throw new VaultError(503, 'The credential store did not acknowledge the deletion.');
    }
}
