// ABOUTME: Shared hosted dependency runtime that reuses Steel clients within one credential while
// ABOUTME: isolating tenants, picking the handle store, and releasing through the owning principal's client.
import type { RequestStateCodec } from '@modelcontextprotocol/server';
import type { ArtifactPublisher } from './core/artifacts.js';
import { loadRegistryConfig, type SteelConfig } from './core/config.js';
import { CdpSessionPool, type ServerDeps, type SessionPool } from './core/context.js';
import { SteelToolError } from './core/errors.js';
import { createHandoffCodec, type HandoffState } from './core/mrtr.js';
import { InMemoryRateLimiter, type RateLimiter } from './core/rate-limit.js';
import { connectRedis, type RedisConnection } from './core/redis.js';
import type { ReleasePath } from './core/registry.js';
import {
    type HandleRegistry,
    InMemoryHandleRegistry,
    principalFromCredential,
    type RegistryDeps,
} from './core/registry.js';
import { RedisHandleRegistry } from './core/registry-redis.js';
import { createSessionPlanCodec, type SessionPlanState } from './core/session-plan.js';
import { SteelRestClient } from './core/steel/rest.js';
import type { SteelApi } from './core/steel/types.js';
import type { BrowserVault } from './core/vault/service.js';
import { canonicalShip } from './core/vault/types.js';
import type { RequestDepsInput } from './http.js';

export interface HostedRuntimeOptions {
    createVault?: (registry: HandleRegistry) => BrowserVault;
    /**
     * Builds the Steel endpoint/profile configuration for this caller. Cloud configurations carry
     * the caller credential to Steel; self-hosted configurations deliberately do not.
     */
    configForCredential(credential: string): SteelConfig;
    createApi?: ((config: SteelConfig) => SteelApi) | undefined;
    createPool?: ((config: SteelConfig, settleMultiplier: number) => SessionPool) | undefined;
    /** Swap this for a shared backend when replicas must exchange handle records. */
    createRegistry?: ((deps: RegistryDeps) => HandleRegistry) | undefined;
    /** Swap this for a shared-store limiter when replicas must share one budget per principal. */
    createLimiter?: ((now: () => Date) => RateLimiter) | undefined;
    onReapError?: ((error: unknown) => void) | undefined;
    onReleased?: ((cause: ReleasePath, backend: 'memory' | 'redis') => void) | undefined;
    now?: (() => Date) | undefined;
    artifacts?: ArtifactPublisher | undefined;
    /** Maximum retained credential/client bundles in this process. New callers fail closed when full. */
    maxTenants?: number | undefined;
    /** Idle bundles without live sessions can be evicted by pruneIdleTenants. */
    tenantIdleMs?: number | undefined;
}

interface TenantClients {
    lastUsedAt: number;
    activeTools: number;
    retired: boolean;
    credential: string;
    config: SteelConfig;
    api: SteelApi;
    pool: SessionPool;
    settleMultiplier: number;
    /**
     * Built once per tenant so both rounds of one human-in-the-loop flow share a key.
     *
     * With no `STEEL_REQUEST_STATE_SECRET` configured this holds a per-process key, which only
     * works while one replica serves the whole flow; a multi-replica deployment must configure one.
     */
    handoffState: RequestStateCodec<HandoffState>;
    sessionPlanState: RequestStateCodec<SessionPlanState>;
}

/**
 * Module-scope runtime for hosted HTTP serving.
 *
 * Handles are shared across request factories, while REST clients and CDP pools are keyed by the
 * one-way principal. Raw credentials stay only in their tenant client bundle, never in handles.
 */
export class HostedRuntime {
    readonly vault: BrowserVault | undefined;
    readonly registry: HandleRegistry;
    /**
     * One cost-weighted budget per principal, shared by every request this runtime serves.
     *
     * The default backend is in memory and therefore **per replica**: two replicas currently grant
     * the same credential two independent budgets, so the effective ceiling is the budget times the
     * replica count. Pass `createLimiter` with a shared-store implementation once the hosted
     * deployment runs more than one replica and the ceiling has to be exact.
     */
    readonly limiter: RateLimiter;
    private readonly tenants = new Map<string, TenantClients>();
    private readonly createApi: (config: SteelConfig) => SteelApi;
    private readonly createPool: (config: SteelConfig, settleMultiplier: number) => SessionPool;
    private readonly now: () => Date;
    private readonly maxTenants: number;
    private readonly tenantIdleMs: number;
    private pruning: Promise<number> | undefined;
    private closed = false;

    constructor(private readonly options: HostedRuntimeOptions) {
        this.createApi = options.createApi ?? (config => new SteelRestClient(config));
        this.createPool = options.createPool ?? ((config, multiplier) => new CdpSessionPool(config, multiplier));
        this.now = options.now ?? (() => new Date());
        this.maxTenants = options.maxTenants ?? 256;
        this.tenantIdleMs = options.tenantIdleMs ?? 300_000;
        if (
            !Number.isSafeInteger(this.maxTenants) ||
            this.maxTenants < 1 ||
            !Number.isSafeInteger(this.tenantIdleMs) ||
            this.tenantIdleMs < 1
        ) {
            throw new Error('Hosted tenant capacity and idle timeout must be positive integers.');
        }
        const registryDeps: RegistryDeps = {
            releaseSteelSession: (steelSessionId, principal) => this.releaseOwnedSession(steelSessionId, principal),
            onReapError: options.onReapError,
            onReleased: cause => options.onReleased?.(cause, this.registry.registryBackend),
        };
        this.registry = (options.createRegistry ?? (deps => new InMemoryHandleRegistry(deps)))(registryDeps);
        this.vault = options.createVault?.(this.registry);
        this.limiter = (options.createLimiter ?? (now => new InMemoryRateLimiter({ now })))(this.now);
    }

    private tenantFor(input: RequestDepsInput): TenantClients {
        if (this.closed) throw new Error('Hosted runtime is closed.');
        const derivedPrincipal = principalFromCredential(input.credential);
        if (input.principal !== derivedPrincipal) {
            throw new Error('Refusing hosted dependencies whose principal does not match their credential.');
        }

        const existing = this.tenants.get(input.principal);
        if (existing) {
            if (existing.credential !== input.credential) {
                throw new Error('A principal collision mapped two different credentials to one tenant.');
            }
            existing.lastUsedAt = this.now().getTime();
            return existing;
        }

        // Metadata-only requests need the static catalog, never a retained browser client. The
        // beginTool guard below prevents a mismatched/malformed request from using ephemeral deps.
        const metadataOnly = [
            'server/discover',
            'tools/list',
            'resources/list',
            'resources/read',
            'initialize',
        ].includes(input.request.headers.get('mcp-method') ?? '');
        if (!metadataOnly && this.tenants.size >= this.maxTenants) {
            throw new SteelToolError('Hosted tenant capacity is full. Retry after idle clients are reclaimed.', {
                code: 'rate_limited',
            });
        }
        const config = this.options.configForCredential(input.credential);
        if (config.deployment === 'cloud' && config.apiKey !== input.credential) {
            throw new Error('Cloud configForCredential must preserve the request credential as config.apiKey.');
        }
        if (config.deployment === 'self_hosted' && config.apiKey !== undefined) {
            throw new Error('Self-hosted configForCredential must not forward the tenant credential to Steel.');
        }
        const settleMultiplier = config.deployment === 'cloud' ? 2 : 1;
        const api = this.createApi(config);
        const pool = this.createPool(config, settleMultiplier);
        const tenant: TenantClients = {
            lastUsedAt: this.now().getTime(),
            activeTools: 0,
            retired: metadataOnly,
            credential: input.credential,
            config,
            api,
            pool,
            settleMultiplier,
            handoffState: createHandoffCodec(config.requestStateSecret),
            sessionPlanState: createSessionPlanCodec(config.requestStateSecret, input.principal),
        };
        if (!metadataOnly) this.tenants.set(input.principal, tenant);
        return tenant;
    }

    depsForRequest = (input: RequestDepsInput): ServerDeps => {
        const tenant = this.tenantFor(input);
        return {
            vault: this.vault
                ? {
                      bindSession: async (record, signal) => {
                          try {
                              return await this.vault!.bindSession(
                                  record,
                                  {
                                      planet: canonicalShip(input.request.headers.get('x-tlon-parent-ship') ?? ''),
                                      moon: canonicalShip(input.request.headers.get('x-tlon-ship') ?? ''),
                                  },
                                  input.credential,
                                  signal
                              );
                          } catch {
                              return false;
                          }
                      },
                      login: (record, signal) => this.vault!.login(record, signal),
                  }
                : undefined,
            config: tenant.config,
            api: tenant.api,
            pool: tenant.pool,
            registry: this.registry,
            limiter: this.limiter,
            handoffState: tenant.handoffState,
            sessionPlanState: tenant.sessionPlanState,
            principal: input.principal,
            settleMultiplier: tenant.settleMultiplier,
            now: this.now,
            artifacts: this.options.artifacts,
            beginTool: () => {
                if (tenant.retired || this.closed)
                    throw new SteelToolError('This request uses an expired client. Retry the tool call.', {
                        code: 'rate_limited',
                    });
                tenant.activeTools += 1;
                let finished = false;
                return () => {
                    if (finished) return;
                    finished = true;
                    tenant.activeTools -= 1;
                    tenant.lastUsedAt = this.now().getTime();
                };
            },
        };
    };

    /**
     * Releases a Steel session through the client that is allowed to release it.
     *
     * The handle registry names the owning principal, so this works for a session another replica
     * created — as long as this replica has served a request from that principal and therefore holds
     * its credential. When it has not, the release fails on purpose: the record then survives for a
     * replica that can, and Steel's own inactivity timeout remains the backstop underneath.
     */
    private async releaseOwnedSession(steelSessionId: string, principal: string): Promise<void> {
        this.vault?.forgetSession(steelSessionId);
        const tenant = this.tenants.get(principal);
        if (!tenant) {
            throw new Error(
                `Cannot release Steel session ${steelSessionId}: this replica has no client for its principal.`
            );
        }

        await tenant.pool.close(steelSessionId);
        await tenant.api.releaseSession(steelSessionId);
    }

    /** Called by the hosted reaper; active tools and every live/pending-handoff record pin a tenant. */
    pruneIdleTenants(): Promise<number> {
        this.vault?.prune();
        this.pruning ??= this.prune().finally(() => {
            this.pruning = undefined;
        });
        return this.pruning;
    }

    private async prune(): Promise<number> {
        let removed = 0;
        for (const [principal, tenant] of this.tenants) {
            if (tenant.activeTools || this.now().getTime() - tenant.lastUsedAt < this.tenantIdleMs) continue;
            if ((await this.registry.list(principal)).length) continue;
            // A tool can start while the shared registry read is in flight. Recheck before retiring.
            if (tenant.activeTools || this.now().getTime() - tenant.lastUsedAt < this.tenantIdleMs || this.closed)
                continue;
            tenant.retired = true;
            this.tenants.delete(principal);
            await tenant.pool.closeAll();
            removed += 1;
        }
        return removed;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.vault?.close();
        const errors: unknown[] = [];
        if (this.pruning) await this.pruning.catch(error => errors.push(error));
        try {
            if (this.registry.shutdownScope === 'process_owned') await this.registry.releaseAll('stream_close');
        } catch (error) {
            errors.push(error);
        } finally {
            const results = await Promise.allSettled(
                [...this.tenants.values()].map(tenant => {
                    tenant.retired = true;
                    return tenant.pool.closeAll();
                })
            );
            for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
            this.tenants.clear();
        }
        if (errors.length) throw new AggregateError(errors, 'Hosted cleanup could not release every resource.');
    }
}

export interface HandleRegistryBackend {
    /** Pass as `createRegistry` to every runtime that must see the same handles. */
    createRegistry: (deps: RegistryDeps) => HandleRegistry;
    /** Closes the shared store. Close the runtimes first, so their shutdown sweep still has one. */
    close(): Promise<void>;
}

export interface HandleRegistryBackendOptions {
    env: Record<string, string | undefined>;
    /** Opens the shared store. The default connects to Redis; tests substitute their own. */
    connect?: ((url: string, onError: (error: unknown) => void) => RedisConnection) | undefined;
    /** Where store connection failures go. Required whenever a shared store is configured. */
    onError?: ((error: unknown) => void) | undefined;
    now?: (() => Date) | undefined;
}

/**
 * Picks where handle records live, from the environment.
 *
 * With `REDIS_URL` set, records go to Redis and any replica can serve a handle any other replica
 * minted — the whole point of round-robin routing with no sticky sessions. Without it, records stay
 * in this process, which is correct for a single replica and for the stdio entrypoint, where one
 * subprocess serves one credential and a shared store would buy nothing.
 */
export function createHandleRegistryBackend(options: HandleRegistryBackendOptions): HandleRegistryBackend {
    const config = loadRegistryConfig(options.env);
    if (!config.redisUrl) {
        return {
            createRegistry: deps => new InMemoryHandleRegistry(deps),
            close: async () => {},
        };
    }

    if (!options.onError) {
        throw new Error(
            'A shared handle store needs onError: a client error event with no listener would take ' +
                'the replica down on the first reconnect.'
        );
    }

    const connection = (options.connect ?? connectRedis)(config.redisUrl, options.onError);
    return {
        createRegistry: deps =>
            new RedisHandleRegistry({
                ...deps,
                commands: connection.commands,
                keyPrefix: config.keyPrefix,
                now: options.now,
            }),
        close: () => connection.close(),
    };
}
