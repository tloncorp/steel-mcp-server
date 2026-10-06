// ABOUTME: Durable vault secrets are explicit deployment configuration, never generated at startup.
import type { HandleRegistry } from '../registry.js';
import { PrivateVaultBrowser } from './browser.js';
import { VaultCipher } from './crypto.js';
import { PioneerVaultStore } from './pioneer.js';
import { BrowserVault } from './service.js';

export function loadVault(
    env: Record<string, string | undefined>,
    browserBaseUrl: string
):
    | {
          create(registry: HandleRegistry): BrowserVault;
          serviceToken: string;
      }
    | undefined {
    if (env.BROWSER_VAULT_ENABLED !== 'true') return undefined;
    const required = (name: string) => {
        const value = env[name]?.trim();
        if (!value) throw new Error(`${name} is required when BROWSER_VAULT_ENABLED=true.`);
        return value;
    };
    const cipher = new VaultCipher(required('BROWSER_VAULT_KEY'), required('BROWSER_VAULT_KEY_ID'));
    const serviceToken = required('BROWSER_VAULT_SERVICE_TOKEN');
    const store = new PioneerVaultStore(required('BROWSER_VAULT_PIONEER_ORIGIN'), required('PIONEER_SIDECAR_TOKEN'));
    const browser = new PrivateVaultBrowser(browserBaseUrl);
    return { serviceToken, create: registry => new BrowserVault({ cipher, store, browser, registry }) };
}
