// ABOUTME: Authenticated, planet/moon-scoped encryption. The deployment key never enters a session record.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import {
    type EncryptedLogin,
    encryptedLoginSchema,
    type LoginMetadata,
    type LoginSecret,
    loginSecretSchema,
    VaultError,
    type VaultIdentity,
} from './types.js';

export class VaultCipher {
    private readonly rootKey: Buffer;

    constructor(
        key: string,
        readonly keyId: string
    ) {
        this.rootKey = Buffer.from(key, 'base64');
        if (
            this.rootKey.length !== 32 ||
            this.rootKey.toString('base64') !== key ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(keyId)
        ) {
            throw new Error(
                'BROWSER_VAULT_KEY must be a base64 32-byte key and BROWSER_VAULT_KEY_ID must be an identifier.'
            );
        }
    }

    private key(identity: VaultIdentity): Buffer {
        return Buffer.from(
            hkdfSync(
                'sha256',
                this.rootKey,
                'tlon/browser-vault/v1',
                JSON.stringify([identity.planet, identity.moon]),
                32
            )
        );
    }

    private aad(record: LoginMetadata): Buffer {
        return Buffer.from(
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
        );
    }

    encrypt(metadata: Omit<LoginMetadata, 'version' | 'keyId'>, secret: LoginSecret): EncryptedLogin {
        const record: LoginMetadata = { ...metadata, version: 1, keyId: this.keyId };
        const nonce = randomBytes(12);
        const key = this.key(record);
        const plaintext = Buffer.from(JSON.stringify(loginSecretSchema.parse(secret)));
        try {
            const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
            cipher.setAAD(this.aad(record));
            const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
            return encryptedLoginSchema.parse({
                ...record,
                nonce: nonce.toString('base64'),
                tag: cipher.getAuthTag().toString('base64'),
                ciphertext: ciphertext.toString('base64'),
            });
        } finally {
            key.fill(0);
            plaintext.fill(0);
        }
    }

    decrypt(identity: VaultIdentity, encrypted: EncryptedLogin): LoginSecret {
        let key: Buffer | undefined;
        let plaintext: Buffer | undefined;
        try {
            const record = encryptedLoginSchema.parse(encrypted);
            if (record.planet !== identity.planet || record.moon !== identity.moon || record.keyId !== this.keyId)
                throw new Error();
            key = this.key(identity);
            const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce, 'base64'), {
                authTagLength: 16,
            });
            decipher.setAAD(this.aad(record));
            decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
            plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
            return loginSecretSchema.parse(JSON.parse(plaintext.toString('utf8')));
        } catch {
            throw new VaultError(503, 'The saved login could not be decrypted.');
        } finally {
            key?.fill(0);
            plaintext?.fill(0);
        }
    }
}
