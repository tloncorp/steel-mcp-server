import { describe, expect, it, vi } from 'vitest';
import { credentialContinuation } from '../../src/core/credential-continuation.js';
import type { CredentialContinuation } from '../../src/core/steel/types.js';
import { FakeSteelApi, testDeps } from '../helpers/fakes.js';

const receipt: CredentialContinuation = {
    pageId: 'target',
    frameUrl: 'https://example.test/login',
    origin: 'https://example.test',
    kind: 'password',
    expiresAt: Date.now() + 60_000,
    submissionAttempted: false,
};

describe('trusted credential continuation', () => {
    it.each(['missing', 'expired', 'wrong page', 'valid'] as const)(
        'checks %s receipt before enabling login',
        async kind => {
            const deps = testDeps({
                env: { STEEL_LOCAL: 'true' },
                api: new FakeSteelApi({
                    continuation:
                        kind === 'missing'
                            ? null
                            : { ...receipt, expiresAt: kind === 'expired' ? 1 : receipt.expiresAt },
                }),
            });
            const record = await deps.registry.create({
                principal: deps.principal,
                steelSessionId: 'browser',
                expiresAt: Date.now() + 60_000,
            });
            const page = await deps.pool.page('browser');
            const match = vi.spyOn(page, 'matchesCredentialContinuation').mockResolvedValue(kind !== 'wrong page');
            expect(await credentialContinuation(deps, record, page)).toEqual(kind === 'valid' ? receipt : null);
            if (kind === 'missing' || kind === 'expired') expect(match).not.toHaveBeenCalled();
        }
    );
});
