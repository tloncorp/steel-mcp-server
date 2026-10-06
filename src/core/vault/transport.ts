// ABOUTME: Bounded private JSON transport. Remote bodies and credentials never become error messages.
import { VaultError } from './types.js';

export async function privateJson(url: URL, init: RequestInit, fetchImpl = fetch): Promise<unknown> {
    try {
        const signal = init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000);
        const response = await fetchImpl(url, { ...init, signal, redirect: 'error', cache: 'no-store' });
        if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 409)
                throw new VaultError(409, 'The saved login changed. Refresh before trying again.');
            if (response.status === 401 || response.status === 403)
                throw new VaultError(403, 'Vault authorization failed.');
            if (response.status === 404) throw new VaultError(404, 'The requested login or form is unavailable.');
            throw new VaultError(503, 'The credential service is unavailable.');
        }
        if (!response.body) throw new Error();
        const reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done) break;
                size += next.value.byteLength;
                if (size > 8 * 1024 * 1024) throw new Error();
                parts.push(next.value);
            }
        } finally {
            await reader.cancel();
        }
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch (error) {
        if (error instanceof VaultError) throw error;
        throw new VaultError(503, 'The credential service is unavailable.');
    }
}
