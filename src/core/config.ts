// ABOUTME: Reads Steel credentials and deployment settings from the environment and derives the
// ABOUTME: CDP connect URL, which must always carry a sessionId or Steel starts an untracked session.
import { randomBytes } from 'node:crypto';
import { DEFAULT_INACTIVITY_TIMEOUT_MS, DEFAULT_SESSION_TIMEOUT_MS } from './lifecycle.js';

/**
 * The named tool presets a connection can select.
 *
 * PLAN §7 also designs `vision` (coordinate tools over Steel's `/computer` endpoint) and `full`
 * (`steel_execute_js`, self-host and stdio only). Neither has tools of its own yet, so neither is
 * offered: a preset a caller can name has to differ from the one next to it, or the name promises a
 * capability the server does not have.
 */
export const PROFILE_NAMES = ['scrape', 'browse'] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];

export type Deployment = 'cloud' | 'self_hosted';

/** Everything the server needs to reach a Steel deployment. */
export interface SteelConfig {
    /** Absent only on a self-hosted deployment, which has no API-key auth. */
    apiKey: string | undefined;
    /** REST base URL with no trailing slash and no `/v1` suffix. */
    baseUrl: string;
    /** WebSocket origin for CDP connections. */
    connectUrl: string;
    deployment: Deployment;
    profile: ProfileName;
    /** Operator-owned inference credentials, never the caller's browser tenant key. */
    jev?: { apiKey: string; model: string };
    /**
     * Hard cap on simultaneous browser sessions. Self-hosted steel-browser runs exactly one;
     * the cloud value is refined from `GET /v1/details` at runtime.
     */
    maxConcurrentSessions: number;
    /** Idle release, in ms, set on every session so a browser frees itself if this process dies. */
    inactivityTimeoutMs: number;
    /**
     * Hard session cap, in ms. Clamped at runtime to the plan maximum when `GET /v1/details` reports
     * one. The API does not always report a maximum, so this remains a requested default rather than
     * being treated as an invented ceiling; Steel is authoritative for account validation.
     */
    sessionTimeoutMs: number;
    /**
     * HMAC key for the multi-round-trip `requestState` a human-in-the-loop handoff round-trips
     * through the client.
     *
     * Read from `STEEL_REQUEST_STATE_SECRET` when the operator supplies one; otherwise a fresh
     * per-process key. That default is correct for one process serving every round of a flow, and
     * wrong for a multi-replica deployment, where a retry landing on another replica cannot verify
     * state this one minted and the caller sees `Invalid or expired requestState`.
     */
    requestStateSecret: string;
    /** Configuration problems worth telling the operator about, logged by the entrypoint. */
    warnings: string[];
}

/** HMAC-SHA256 wants a full-width key; the codec refuses anything shorter. */
const MIN_REQUEST_STATE_SECRET_BYTES = 32;

const CLOUD_BASE_URL = 'https://api.steel.dev';
const CLOUD_CONNECT_URL = 'wss://connect.steel.dev';
/** Where a self-hosted steel-browser listens by default, matching the image's own default. */
const LOCAL_BASE_URL = 'http://localhost:3000';
const CLOUD_HOSTNAME = 'steel.dev';

/**
 * Resolves the request-state HMAC key.
 *
 * A short configured value is refused rather than padded: silently strengthening a weak operator
 * secret would make the deployment look protected while every replica agreed on a guessable key.
 */
function resolveRequestStateSecret(raw: string | undefined): string {
    const configured = raw?.trim();
    if (!configured) return randomBytes(MIN_REQUEST_STATE_SECRET_BYTES).toString('base64url');
    if (Buffer.byteLength(configured, 'utf8') < MIN_REQUEST_STATE_SECRET_BYTES) {
        throw new Error(
            `STEEL_REQUEST_STATE_SECRET must be at least ${MIN_REQUEST_STATE_SECRET_BYTES} bytes long. ` +
                'Generate one with: openssl rand -base64 32'
        );
    }
    return configured;
}

/** Removes a trailing `/v1` and any trailing slashes, reconciling the SDK and CLI conventions. */
export function normalizeBaseUrl(raw: string): string {
    return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function parseIntEnv(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Expected a positive integer, got "${value}"`);
    }
    return parsed;
}

function toWebSocketUrl(httpUrl: string): string {
    return httpUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

/**
 * True only for `steel.dev` itself and its subdomains.
 *
 * A bare suffix test would classify `evilsteel.dev` as Steel Cloud and hand it the API key as a
 * bearer credential, so the dot boundary is load-bearing.
 */
function isCloudHostname(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return host === CLOUD_HOSTNAME || host.endsWith(`.${CLOUD_HOSTNAME}`);
}

/** Builds the configuration from a process environment, failing loudly on an unusable combination. */
export function loadConfig(env: Record<string, string | undefined>): SteelConfig {
    const warnings: string[] = [];

    // v1 honoured STEEL_LOCAL and the shipped README still walks through toggling it. An upgrading
    // self-hoster with a leftover key would otherwise silently start creating billed cloud sessions.
    const local = env.STEEL_LOCAL?.trim().toLowerCase() === 'true';
    const baseUrl = normalizeBaseUrl(env.STEEL_BASE_URL ?? (local ? LOCAL_BASE_URL : CLOUD_BASE_URL));
    const deployment: Deployment = !local && isCloudHostname(new URL(baseUrl).hostname) ? 'cloud' : 'self_hosted';
    const apiKey = deployment === 'cloud' ? env.STEEL_API_KEY?.trim() || undefined : undefined;

    if (env.GLOBAL_WAIT_SECONDS !== undefined) {
        warnings.push(
            'GLOBAL_WAIT_SECONDS is no longer used. Every action waits for the page to settle by ' +
                'itself; when something genuinely arrives later, call browser_wait_for and name what ' +
                'you are waiting for.'
        );
    }

    if (deployment === 'cloud' && !apiKey) {
        throw new Error(
            'STEEL_API_KEY is required to reach Steel Cloud. Set it, or point STEEL_BASE_URL at a self-hosted steel-browser.'
        );
    }

    // Blank counts as unset: an MCPB host substitutes the empty string for an optional user_config
    // value the user left alone, and refusing that would name a variable they never set.
    const profileName = env.STEEL_PROFILE?.trim() || 'browse';
    if (!(PROFILE_NAMES as readonly string[]).includes(profileName)) {
        throw new Error(`Unknown STEEL_PROFILE "${profileName}". Expected one of: ${PROFILE_NAMES.join(', ')}.`);
    }

    return {
        apiKey,
        baseUrl,
        connectUrl: env.STEEL_CONNECT_URL ?? (deployment === 'cloud' ? CLOUD_CONNECT_URL : toWebSocketUrl(baseUrl)),
        deployment,
        profile: profileName as ProfileName,
        jev: env.OPENROUTER_API_KEY?.trim()
            ? { apiKey: env.OPENROUTER_API_KEY.trim(), model: env.BROWSER_JEV_MODEL?.trim() || '~typesafe/jev-latest' }
            : undefined,
        maxConcurrentSessions: parseIntEnv(env.STEEL_MAX_SESSIONS, deployment === 'self_hosted' ? 1 : 10),
        inactivityTimeoutMs: parseIntEnv(env.STEEL_INACTIVITY_TIMEOUT_MS, DEFAULT_INACTIVITY_TIMEOUT_MS),
        sessionTimeoutMs: parseIntEnv(env.STEEL_SESSION_TIMEOUT_MS, DEFAULT_SESSION_TIMEOUT_MS),
        requestStateSecret: resolveRequestStateSecret(env.STEEL_REQUEST_STATE_SECRET),
        warnings,
    };
}

/** Where handle records live, which is what decides whether replicas can serve each other's handles. */
export interface RegistryConfig {
    /** Absent means records stay in this process, which is correct for exactly one replica. */
    redisUrl: string | undefined;
    /** Key namespace, so one store can hold more than one deployment's records. */
    keyPrefix: string;
}

const DEFAULT_REGISTRY_KEY_PREFIX = 'steel-mcp';

/**
 * Reads the handle-registry backend from the environment.
 *
 * The URL is checked but never echoed: it usually carries a password, and an unusable value must
 * fail here rather than send that password to whatever happens to answer.
 *
 * This is also where a shared store and a per-process handoff key are refused as a pair. The check
 * belongs here rather than in `loadConfig` because only a deployment that actually shares handles
 * calls this, so the stdio entrypoint — where `REDIS_URL` may be set for something else entirely
 * and means nothing — is never affected by it.
 */
export function loadRegistryConfig(env: Record<string, string | undefined>): RegistryConfig {
    const redisUrl = env.REDIS_URL?.trim() || undefined;
    if (redisUrl !== undefined) {
        if (env.OPENROUTER_API_KEY?.trim()) {
            throw new Error(
                'Jev browser runs require a single MCP replica with the in-memory registry; unset REDIS_URL or OPENROUTER_API_KEY.'
            );
        }
        const protocol = URL.canParse(redisUrl) ? new URL(redisUrl).protocol : undefined;
        if (protocol !== 'redis:' && protocol !== 'rediss:') {
            throw new Error(
                'REDIS_URL must be a redis:// or rediss:// URL. Its value is not shown here because ' +
                    'it usually contains a password.'
            );
        }

        // Refused rather than warned about, because the two settings together are guaranteed wrong
        // and nothing downstream can recover: a retried human-in-the-loop handoff is routed to
        // whichever replica answers, and every replica but the one that minted the state rejects it
        // as expired — after a person has already signed in or solved a challenge. A generated key
        // does not survive a restart either, so one replica is no excuse for leaving it unset.
        if (!env.STEEL_REQUEST_STATE_SECRET?.trim()) {
            throw new Error(
                'REDIS_URL shares handle records between replicas, so STEEL_REQUEST_STATE_SECRET must ' +
                    'be set to the same value on every one of them. Without it each replica signs ' +
                    'human-in-the-loop handoff state with its own per-process key, and a retried handoff ' +
                    'is refused once the person has already done the work. Generate one with: ' +
                    'openssl rand -base64 32'
            );
        }
    }

    return {
        redisUrl,
        keyPrefix: env.REDIS_KEY_PREFIX?.trim() || DEFAULT_REGISTRY_KEY_PREFIX,
    };
}

/**
 * Picks the idle timeout to send with a session, always strictly below the hard timeout.
 *
 * Steel ignores `inactivityTimeout` entirely when it is greater than or equal to `timeout`. Sending
 * an equal value therefore silently disables the one teardown layer that survives this process
 * dying, its replica being rescheduled, and the client vanishing. Returns `undefined` when no
 * useful value exists, so an inert number is never sent at all.
 */
export function resolveInactivityTimeout(configuredMs: number, hardTimeoutMs: number): number | undefined {
    if (configuredMs < hardTimeoutMs) return configuredMs;
    return undefined;
}

/** The subset of configuration a CDP URL is built from. */
export type CdpEndpoint = Pick<SteelConfig, 'deployment' | 'connectUrl'> & { apiKey?: string | undefined };

/**
 * Builds the CDP WebSocket URL for a session.
 *
 * `sessionId` is mandatory: connecting to Steel without one makes it create a fresh billed
 * session that nothing in this process knows about, so an empty id is a programming error.
 */
export function buildCdpUrl(endpoint: CdpEndpoint, sessionId: string): string {
    if (!sessionId) {
        throw new Error(
            'Refusing to open a CDP connection without a sessionId: Steel would start an untracked billed session.'
        );
    }
    const url = new URL(endpoint.connectUrl);
    if (endpoint.apiKey) url.searchParams.set('apiKey', endpoint.apiKey);
    url.searchParams.set('sessionId', sessionId);
    return url.toString();
}
