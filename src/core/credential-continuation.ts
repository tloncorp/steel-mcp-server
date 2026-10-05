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
    'Sensitive fields were supplied securely for this page. This does not prove sign-in or authorize a purchase or other consequential action. ' +
    'Inspect the current page, check validation and pending requests, and continue the task using its actual controls. ' +
    'Do not request the same information again unless the site rejects it or needs new input. Never read, reveal or retype the filled values.';
