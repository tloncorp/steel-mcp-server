// ABOUTME: Verifies browser-owned, short-lived fill receipts before continuing a login.
// ABOUTME: A receipt authorizes use of filled fields, not access to their values or a new origin.
import type { ServerDeps } from './context.js';
import type { BrowserPage } from './page.js';
import type { HandleRecord } from './registry.js';
import type { CredentialContinuation } from './steel/types.js';

export async function credentialContinuation(
    deps: ServerDeps,
    record: HandleRecord,
    page: BrowserPage,
    signal?: AbortSignal
): Promise<CredentialContinuation | null> {
    if (deps.config.deployment !== 'self_hosted') return null;
    const receipt = await deps.api.getCredentialContinuation(record.steelSessionId, signal);
    if (!receipt || receipt.expiresAt <= deps.now().getTime()) return null;
    return (await page.matchesCredentialContinuation(receipt)) ? receipt : null;
}

export const CREDENTIAL_CONTINUATION_GUIDANCE =
    'Credentials were supplied securely for this page. This is not proof of sign-in. ' +
    'Inspect the current page and use browser_run or browser_act to finish the login with its actual controls. ' +
    'Check validation and pending requests before retrying a submission. Do not request the same credentials again ' +
    'unless the site rejects them or needs new input. Never read, reveal or retype the filled secrets.';
