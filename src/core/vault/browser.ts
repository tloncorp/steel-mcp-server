// ABOUTME: Secret-bearing browser calls bypass MCP serialization and general REST error reporting.
// ABOUTME: Handoffs resolve their bound form while agent login discovery inspects the current page.
import { z } from 'zod';
import { privateJson } from './transport.js';
import { formTarget, type SecureForm, secureFormSchema, type VaultBrowser, VaultError } from './types.js';

export class PrivateVaultBrowser implements VaultBrowser {
    constructor(
        private readonly baseUrl: string,
        private readonly fetchImpl = fetch
    ) {}

    private url(sessionId: string): URL {
        z.uuid().parse(sessionId);
        return new URL(`/v1/sessions/${sessionId}/credential-form`, this.baseUrl);
    }

    async discover(sessionId: string, signal?: AbortSignal): Promise<SecureForm | null> {
        return this.read(this.url(sessionId), signal);
    }

    async getBound(sessionId: string, formId: string, signal?: AbortSignal): Promise<SecureForm | null> {
        const url = this.url(sessionId);
        url.searchParams.set('formId', formId);
        return this.read(url, signal);
    }

    private async read(url: URL, signal?: AbortSignal): Promise<SecureForm | null> {
        try {
            const result = secureFormSchema.safeParse(await privateJson(url, { signal }, this.fetchImpl));
            if (!result.success) throw new VaultError(503, 'The browser returned an invalid secure form.');
            return result.data;
        } catch (error) {
            if (error instanceof VaultError && error.status === 404) return null;
            throw error;
        }
    }

    async fill(
        sessionId: string,
        form: SecureForm,
        values: Record<string, string>,
        submit: boolean,
        signal?: AbortSignal
    ): Promise<{ submitted: boolean }> {
        const result = z.object({ submitted: z.boolean() }).safeParse(
            await privateJson(
                this.url(sessionId),
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ target: formTarget(form), values, submit, vault: true }),
                    signal,
                },
                this.fetchImpl
            )
        );
        if (!result.success) throw new VaultError(503, 'The browser did not confirm the fill.');
        return result.data;
    }
}
