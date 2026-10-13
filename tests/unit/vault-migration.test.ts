// ABOUTME: Persisted v1 credentials migrate only after authenticated decryption.
// ABOUTME: Invalid keys and identities never produce replacement ciphertext.
import { createCipheriv, hkdfSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { VaultCipher } from '../../src/core/vault/crypto.js';
import { loginMigration } from '../../src/core/vault/migration.js';

const identity = { planet: 'sampel-palnet', moon: 'pinser-botter-sampel-palnet' };
const root = Buffer.alloc(32, 7).toString('base64');
const secret = { label: 'Personal', username: 'me@example.com', password: 'saved-password' };
function stored() {
    const record = {
        ...identity,
        id: '8e40b5f5-fd41-4851-8922-b9545e470d6e',
        version: 1,
        keyId: 'primary',
        origin: 'https://login.example',
        revision: 4,
        createdAt: 1,
        updatedAt: 2,
    };
    const key = Buffer.from(
        hkdfSync(
            'sha256',
            Buffer.from(root, 'base64'),
            'tlon/browser-vault/v1',
            JSON.stringify([identity.planet, identity.moon]),
            32
        )
    );
    const nonce = Buffer.alloc(12, 3);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(
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
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret)), cipher.final()]);
    return {
        ...record,
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
    };
}
it('preserves the password and defaults migrated automatic reuse to ask', async () => {
    const cipher = new VaultCipher(root, 'primary');
    const value = stored();
    const record = await loginMigration(root, cipher)(identity, value, async () =>
        Buffer.alloc(32, 9).toString('base64')
    );
    expect(record).toMatchObject({
        ...identity,
        id: value.id,
        revision: 5,
        permission: 'ask',
        label: secret.label,
        username: secret.username,
    });
    expect(cipher.decrypt(identity, record)).toEqual(secret);
    expect(value.version).toBe(1);
    await expect(
        loginMigration(root, cipher)(identity, record, async () => {
            throw new Error();
        })
    ).resolves.toEqual(record);
});
it('rejects a wrong server key, changed metadata, and another identity', async () => {
    const cipher = new VaultCipher(root, 'primary');
    const factor = async () => Buffer.alloc(32, 9).toString('base64');
    await expect(
        loginMigration(Buffer.alloc(32).toString('base64'), cipher)(identity, stored(), factor)
    ).rejects.toThrow('migration');
    await expect(
        loginMigration(root, cipher)(identity, { ...stored(), origin: 'https://evil.example' }, factor)
    ).rejects.toThrow('migration');
    await expect(
        loginMigration(root, cipher)({ ...identity, moon: 'worlet-samtes-sampel-palnet' }, stored(), factor)
    ).rejects.toThrow('migration');
});
