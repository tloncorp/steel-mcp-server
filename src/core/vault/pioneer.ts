// ABOUTME: The only vault storage connection: verified identities and ciphertext go directly to Pioneer.
// ABOUTME: Owner-authenticated changes use revision checks and private sidecar requests.
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
        private readonly pioneerToken: string,
        private readonly fetchImpl = fetch,
        private readonly migrate?: (
            identity: VaultIdentity,
            value: unknown,
            factor: () => Promise<string>
        ) => Promise<EncryptedLogin>
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
            pioneerToken.trim().length < 32 ||
            /[\r\n]/.test(pioneerToken)
        ) {
            throw new Error(
                'The vault requires an HTTPS Pioneer origin template and a scoped Pioneer vault token of at least 32 characters.'
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
                headers: { 'content-type': 'application/json', authorization: `Basic ${this.pioneerToken}` },
                body: JSON.stringify({ ...identity, proof, operation, ...payload }),
                signal,
            },
            this.fetchImpl
        );
    }

    async factor(identity: VaultIdentity, proof: VaultProof, signal?: AbortSignal): Promise<string> {
        const result = z
            .object({ factor: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) })
            .safeParse(await this.request(identity, proof, 'factor', {}, signal));
        if (!result.success) throw new VaultError(503, 'The ship encryption factor is unavailable.');
        return result.data.factor;
    }

    async permission(
        identity: VaultIdentity,
        proof: VaultProof,
        id: string,
        expectedRevision: number,
        permission: 'ask' | 'allow',
        signal?: AbortSignal
    ): Promise<void> {
        const result = await this.request(identity, proof, 'permission', { id, expectedRevision, permission }, signal);
        if (!z.object({ ok: z.literal(true) }).safeParse(result).success)
            throw new VaultError(503, 'The credential permission was not acknowledged.');
    }

    async verify(identity: VaultIdentity, proof: VaultProof, signal?: AbortSignal): Promise<void> {
        const actual = identitySchema.safeParse(await this.request(identity, proof, 'verify', {}, signal));
        if (!actual.success || !sameIdentity(actual.data, identity))
            throw new VaultError(403, 'Vault identity verification failed.');
    }

    async list(identity: VaultIdentity, proof: VaultProof, signal?: AbortSignal): Promise<EncryptedLogin[]> {
        const result = z
            .object({ records: z.array(z.unknown()).max(200) })
            .safeParse(await this.request(identity, proof, 'list', {}, signal));
        if (!result.success) throw new VaultError(503, 'The credential store returned invalid records.');
        const records: EncryptedLogin[] = [];
        for (const value of result.data.records) {
            const parsed = encryptedLoginSchema.safeParse(value);
            if (parsed.success && sameIdentity(parsed.data, identity)) {
                records.push(parsed.data);
            } else {
                if (!this.migrate) throw new VaultError(503, 'The credential store returned invalid records.');
                if (proof.kind !== 'owner')
                    throw new VaultError(503, 'Open saved logins as the owner to update this credential.');
                const migrated = await this.migrate(identity, value, () => this.factor(identity, proof, signal));
                await this.put(identity, proof, migrated, migrated.revision - 1, signal);
                records.push(migrated);
            }
        }
        return records;
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
