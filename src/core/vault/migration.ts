// ABOUTME: Migrates stored v1 ciphertext under owner authorization without discarding credentials.
// ABOUTME: Records receive a ship factor and require consent before automatic reuse.
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { z } from 'zod';
import type { VaultCipher } from './crypto.js';
import {
    type EncryptedLogin,
    encryptedLoginSchema,
    loginSecretSchema,
    sameIdentity,
    VaultError,
    type VaultIdentity,
} from './types.js';

const legacySchema = encryptedLoginSchema
    .omit({ label: true, permission: true, factor: true })
    .extend({ version: z.literal(1) })
    .strict();

export function loginMigration(rootKey: string, cipher: VaultCipher) {
    return async (identity: VaultIdentity, value: unknown, factor: () => Promise<string>): Promise<EncryptedLogin> => {
        const current = encryptedLoginSchema.safeParse(value);
        if (current.success && sameIdentity(identity, current.data)) return current.data;
        let key: Buffer | undefined;
        let plaintext: Buffer | undefined;
        try {
            const record = legacySchema.parse(value);
            if (!sameIdentity(record, identity) || record.keyId !== cipher.keyId) throw new Error();
            key = Buffer.from(
                hkdfSync(
                    'sha256',
                    Buffer.from(rootKey, 'base64'),
                    'tlon/browser-vault/v1',
                    JSON.stringify([identity.planet, identity.moon]),
                    32
                )
            );
            const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce, 'base64'));
            decipher.setAAD(
                Buffer.from(
                    JSON.stringify([
                        'tlon/browser-vault',
                        record.version,
                        record.keyId,
                        record.planet,
                        record.moon,
                        record.id,
                        record.origin,
                        record.revision,
                        record.createdAt,
                        record.updatedAt,
                    ])
                )
            );
            decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
            plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
            const secret = loginSecretSchema.parse(JSON.parse(plaintext.toString('utf8')));
            return cipher.encrypt(
                {
                    ...identity,
                    id: record.id,
                    origin: record.origin,
                    createdAt: record.createdAt,
                    updatedAt: Date.now(),
                    revision: record.revision + 1,
                    label: secret.label,
                    permission: 'ask',
                    factor: await factor(),
                },
                secret
            );
        } catch {
            throw new VaultError(503, 'This saved login requires owner migration with its encryption key.');
        } finally {
            key?.fill(0);
            plaintext?.fill(0);
        }
    };
}
