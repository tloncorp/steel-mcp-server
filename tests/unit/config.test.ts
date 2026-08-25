// ABOUTME: Unit tests for environment configuration: base URL normalisation, deployment detection
// ABOUTME: and the CDP connect URL, which must always carry both apiKey and sessionId on cloud.
import { describe, expect, it } from 'vitest';
import {
    buildCdpUrl,
    loadConfig,
    loadRegistryConfig,
    normalizeBaseUrl,
    resolveInactivityTimeout,
} from '../../src/core/config.js';
import { resolveRegistryIdleMs } from '../../src/core/lifecycle.js';

describe('normalizeBaseUrl', () => {
    it('strips a trailing /v1 so the CLI-style and SDK-style values agree', () => {
        expect(normalizeBaseUrl('https://api.steel.dev/v1')).toBe('https://api.steel.dev');
        expect(normalizeBaseUrl('https://api.steel.dev/v1/')).toBe('https://api.steel.dev');
    });

    it('strips trailing slashes', () => {
        expect(normalizeBaseUrl('http://localhost:3000///')).toBe('http://localhost:3000');
    });

    it('leaves an already-normal URL alone', () => {
        expect(normalizeBaseUrl('https://api.steel.dev')).toBe('https://api.steel.dev');
    });
});

describe('loadConfig', () => {
    it('defaults to Steel Cloud with the browse profile', () => {
        const config = loadConfig({ STEEL_API_KEY: 'ste-abc' });
        expect(config.baseUrl).toBe('https://api.steel.dev');
        expect(config.deployment).toBe('cloud');
        expect(config.profile).toBe('browse');
        expect(config.apiKey).toBe('ste-abc');
        expect(config.inactivityTimeoutMs).toBe(600_000);
        expect(resolveRegistryIdleMs(config.inactivityTimeoutMs)).toBe(630_000);
    });

    it('does not treat a lookalike domain as Steel Cloud', () => {
        // Without a dot boundary, evilsteel.dev would be classified as Cloud and handed the key.
        for (const host of ['evilsteel.dev', 'notsteel.dev', 'steel.dev.attacker.test']) {
            const config = loadConfig({ STEEL_API_KEY: 'ste-secret', STEEL_BASE_URL: `https://${host}` });
            expect(config.deployment, `${host} was classified as Steel Cloud`).toBe('self_hosted');
        }
    });

    it('still recognises Steel Cloud and its subdomains', () => {
        for (const host of ['steel.dev', 'api.steel.dev', 'api.eu.steel.dev']) {
            const config = loadConfig({ STEEL_API_KEY: 'ste-secret', STEEL_BASE_URL: `https://${host}` });
            expect(config.deployment, `${host} was not recognised as Steel Cloud`).toBe('cloud');
        }
    });

    it('honours STEEL_LOCAL, which the shipped README tells self-hosters to toggle', () => {
        // An upgrading self-hoster with a leftover key would otherwise silently start creating
        // billed cloud sessions.
        const local = loadConfig({ STEEL_LOCAL: 'true', STEEL_API_KEY: 'ste-leftover-key' });
        expect(local.deployment).toBe('self_hosted');
        expect(local.baseUrl).toBe('http://localhost:3000');
        expect(local.apiKey, 'a local deployment kept a cloud credential').toBeUndefined();
    });

    it('waives the API key requirement when STEEL_LOCAL is set', () => {
        expect(() => loadConfig({ STEEL_LOCAL: 'true' })).not.toThrow();
    });

    it('lets an explicit base URL win over the STEEL_LOCAL default', () => {
        const config = loadConfig({ STEEL_LOCAL: 'true', STEEL_BASE_URL: 'http://steel-browser:3000' });
        expect(config.baseUrl).toBe('http://steel-browser:3000');
        expect(config.deployment).toBe('self_hosted');
    });

    it('treats STEEL_LOCAL=false as the cloud it names', () => {
        expect(loadConfig({ STEEL_LOCAL: 'false', STEEL_API_KEY: 'k' }).deployment).toBe('cloud');
    });

    it('warns about the retired GLOBAL_WAIT_SECONDS instead of ignoring it', () => {
        const config = loadConfig({ STEEL_API_KEY: 'k', GLOBAL_WAIT_SECONDS: '2' });
        expect(config.warnings.join(' ')).toMatch(/GLOBAL_WAIT_SECONDS/);
        expect(config.warnings.join(' '), 'the warning does not name the replacement').toMatch(/browser_wait_for/);
    });

    it('has no warnings for a plain configuration', () => {
        expect(loadConfig({ STEEL_API_KEY: 'k' }).warnings).toEqual([]);
    });

    it('detects a self-hosted deployment from a non-Steel base URL', () => {
        const config = loadConfig({ STEEL_BASE_URL: 'http://localhost:3000' });
        expect(config.deployment).toBe('self_hosted');
        expect(config.maxConcurrentSessions).toBe(1);
    });

    it('lets a patched multi-session self-host set its concurrency limit', () => {
        const config = loadConfig({
            STEEL_BASE_URL: 'http://steel-browser:3000',
            STEEL_MAX_SESSIONS: '4',
        });

        expect(config.deployment).toBe('self_hosted');
        expect(config.maxConcurrentSessions).toBe(4);
    });

    it('reads the profile from the environment and rejects unknown names', () => {
        expect(loadConfig({ STEEL_API_KEY: 'k', STEEL_PROFILE: 'scrape' }).profile).toBe('scrape');
        expect(() => loadConfig({ STEEL_API_KEY: 'k', STEEL_PROFILE: 'turbo' })).toThrow(/turbo/);
    });

    it('treats a blank profile as unset, because an MCPB host substitutes one for optional config', () => {
        // manifest.json maps STEEL_PROFILE to an optional user_config value. A host that substitutes
        // the empty string for one the user left alone would otherwise fail startup with
        // `Unknown STEEL_PROFILE ""` — a message naming a variable the user never set.
        expect(loadConfig({ STEEL_API_KEY: 'k', STEEL_PROFILE: '' }).profile).toBe('browse');
        expect(loadConfig({ STEEL_API_KEY: 'k', STEEL_PROFILE: '  ' }).profile).toBe('browse');
    });

    it('refuses a designed-but-unbuilt profile instead of silently serving browse', () => {
        // vision and full are named in PLAN §7 and have no tools of their own yet. Accepting either
        // would start a session-capable server that quietly lacks what the name was chosen for.
        for (const profile of ['vision', 'full']) {
            expect(() => loadConfig({ STEEL_API_KEY: 'k', STEEL_PROFILE: profile })).toThrow(/scrape, browse/);
        }
    });

    it('refuses a cloud deployment with no API key', () => {
        expect(() => loadConfig({})).toThrow(/STEEL_API_KEY/);
    });

    it('uses the operator request-state secret so every replica can verify a retried handoff', () => {
        const secret = 'x'.repeat(48);
        expect(loadConfig({ STEEL_API_KEY: 'k', STEEL_REQUEST_STATE_SECRET: secret }).requestStateSecret).toBe(secret);
    });

    it('generates a distinct per-process secret when none is configured', () => {
        const first = loadConfig({ STEEL_API_KEY: 'k' }).requestStateSecret;
        const second = loadConfig({ STEEL_API_KEY: 'k' }).requestStateSecret;
        expect(Buffer.byteLength(first, 'utf8')).toBeGreaterThanOrEqual(32);
        expect(first).not.toBe(second);
    });

    it('refuses a configured secret too short to be an HMAC key, rather than truncating it', () => {
        expect(() => loadConfig({ STEEL_API_KEY: 'k', STEEL_REQUEST_STATE_SECRET: 'short' })).toThrow(
            /STEEL_REQUEST_STATE_SECRET/
        );
    });

    it('does not put the Steel credential in the request-state secret', () => {
        expect(loadConfig({ STEEL_API_KEY: 'ste-supersecret' }).requestStateSecret).not.toContain('supersecret');
    });

    it('says nothing about REDIS_URL, which is not this loader concern', () => {
        // The stdio entrypoint is the only thing that reads these warnings today, and a shared
        // handle store means nothing there. The refusal belongs to loadRegistryConfig instead.
        expect(loadConfig({ STEEL_API_KEY: 'k', REDIS_URL: 'redis://cache:6379' }).warnings).toEqual([]);
    });
});

describe('resolveInactivityTimeout', () => {
    it('keeps the configured idle timeout when it is safely below the hard timeout', () => {
        expect(resolveInactivityTimeout(600_000, 900_000)).toBe(600_000);
    });

    it('relies on hard expiry when configured inactivity is not strictly shorter', () => {
        for (const timeout of [600_000, 599_999, 60_000, 2_000]) {
            expect(resolveInactivityTimeout(600_000, timeout)).toBeUndefined();
        }
    });

    it('omits the idle timeout rather than sending a uselessly small one', () => {
        expect(resolveInactivityTimeout(600_000, 500)).toBeUndefined();
    });
});

describe('buildCdpUrl', () => {
    it('always includes both apiKey and sessionId on cloud, never just one', () => {
        const url = new URL(
            buildCdpUrl({ deployment: 'cloud', apiKey: 'ste-abc', connectUrl: 'wss://connect.steel.dev' }, 'sess-uuid')
        );
        expect(url.origin).toBe('wss://connect.steel.dev');
        expect(url.searchParams.get('apiKey')).toBe('ste-abc');
        expect(url.searchParams.get('sessionId')).toBe('sess-uuid');
    });

    it('passes sessionId on self-hosted too so no untracked session is created', () => {
        const url = new URL(buildCdpUrl({ deployment: 'self_hosted', connectUrl: 'ws://localhost:3000' }, 'sess-uuid'));
        expect(url.searchParams.get('sessionId')).toBe('sess-uuid');
        expect(url.searchParams.has('apiKey')).toBe(false);
    });

    it('refuses to build a URL without a session id, which would silently start a billed session', () => {
        expect(() => buildCdpUrl({ deployment: 'cloud', apiKey: 'k', connectUrl: 'wss://c' }, '')).toThrow(/sessionId/);
    });
});

describe('loadRegistryConfig', () => {
    /** Sharing a handle store is refused without this, so every URL case has to carry one. */
    const SECRET = { STEEL_REQUEST_STATE_SECRET: 'x'.repeat(48) };

    it('keeps handle records in this process when REDIS_URL is absent or blank', () => {
        expect(loadRegistryConfig({}).redisUrl).toBeUndefined();
        expect(loadRegistryConfig({ REDIS_URL: '   ' }).redisUrl).toBeUndefined();
    });

    it('accepts a redis and a rediss URL', () => {
        expect(loadRegistryConfig({ ...SECRET, REDIS_URL: ' redis://cache:6379 ' }).redisUrl).toBe(
            'redis://cache:6379'
        );
        expect(loadRegistryConfig({ ...SECRET, REDIS_URL: 'rediss://cache:6380' }).redisUrl).toBe(
            'rediss://cache:6380'
        );
    });

    it('refuses to share a handle store while each replica signs handoffs with its own key', () => {
        // Not a warning: with records shared and the key per process, a retried handoff is routed to
        // whichever replica answers and every replica but one refuses state it did not mint — after
        // the person has already signed in. Nothing downstream can recover from that.
        const error = (() => {
            try {
                loadRegistryConfig({ REDIS_URL: 'redis://cache:6379' });
            } catch (thrown) {
                return thrown as Error;
            }
            throw new Error('Expected a shared store with no configured secret to be refused.');
        })();

        expect(error.message).toMatch(/STEEL_REQUEST_STATE_SECRET/);
        expect(error.message, 'the error does not name the setting that triggered it').toMatch(/REDIS_URL/);
        expect(error.message, 'the error does not say how to produce a secret').toMatch(/openssl/);
    });

    it('treats a blank secret as no secret at all', () => {
        expect(() =>
            loadRegistryConfig({ REDIS_URL: 'redis://cache:6379', STEEL_REQUEST_STATE_SECRET: '   ' })
        ).toThrow(/STEEL_REQUEST_STATE_SECRET/);
    });

    it('checks the URL before the secret, so an unusable URL is still named first', () => {
        expect(() => loadRegistryConfig({ REDIS_URL: 'https://cache:6379' })).toThrow(/rediss?:\/\//);
    });

    it('namespaces keys so one store can serve more than one deployment', () => {
        expect(loadRegistryConfig({}).keyPrefix).toBe('steel-mcp');
        expect(loadRegistryConfig({ REDIS_KEY_PREFIX: 'staging' }).keyPrefix).toBe('staging');
    });

    it('rejects a URL that is not Redis, rather than handing a password to whatever answers', () => {
        for (const value of ['https://cache:6379', 'cache:6379', 'not a url']) {
            expect(() => loadRegistryConfig({ REDIS_URL: value }), `${value} was accepted`).toThrow(/rediss?:\/\//);
        }
    });

    it('never echoes the URL, which usually carries a password', () => {
        expect(() => loadRegistryConfig({ REDIS_URL: 'https://user:hunter2@cache:6379' })).toThrow(
            expect.objectContaining({ message: expect.not.stringContaining('hunter2') })
        );
    });
});
