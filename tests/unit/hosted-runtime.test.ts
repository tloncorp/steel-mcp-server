// ABOUTME: Unit tests for the hosted dependency runtime: clients reused per principal and isolated
// ABOUTME: across credentials, per-principal budgets, owner-routed releases, and the registry backend.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import type { SessionPool } from '../../src/core/context.js';
import type { BrowserPage } from '../../src/core/page.js';
import { DEFAULT_RATE_LIMIT_POLICY, RATE_LIMIT_NAME, toolCost } from '../../src/core/rate-limit.js';
import { InMemoryHandleRegistry, principalFromCredential } from '../../src/core/registry.js';
import { RedisHandleRegistry } from '../../src/core/registry-redis.js';
import { createHandleRegistryBackend, HostedRuntime } from '../../src/hosted-runtime.js';
import { FakeRedis } from '../helpers/fake-redis.js';
import { FakeSteelApi } from '../helpers/fakes.js';

class RecordingPool implements SessionPool {
    readonly closed: string[] = [];

    async page(): Promise<BrowserPage> {
        throw new Error('This runtime test does not open a browser page.');
    }

    async close(steelSessionId: string): Promise<void> {
        this.closed.push(steelSessionId);
    }

    async closeAll(): Promise<void> {}
}

function input(credential: string) {
    return {
        credential,
        principal: principalFromCredential(credential),
        request: new Request('https://mcp.steel.dev/mcp', { method: 'POST' }),
    };
}

interface HarnessOptions {
    /** Shared store, so two harnesses become two replicas of one deployment. */
    store?: FakeRedis;
    onReapError?: ((error: unknown) => void) | undefined;
}

function harness(options: HarnessOptions = {}) {
    const apis = new Map<string, FakeSteelApi>();
    const pools = new Map<string, RecordingPool>();
    const runtime = new HostedRuntime({
        configForCredential: credential => loadConfig({ STEEL_API_KEY: credential }),
        createApi: config => {
            const api = new FakeSteelApi();
            apis.set(config.apiKey!, api);
            return api;
        },
        createPool: config => {
            const pool = new RecordingPool();
            pools.set(config.apiKey!, pool);
            return pool;
        },
        createRegistry: options.store
            ? deps => new RedisHandleRegistry({ ...deps, commands: options.store! })
            : undefined,
        onReapError: options.onReapError,
    });
    return { runtime, apis, pools };
}

describe('HostedRuntime rate limiting', () => {
    it('hands every request one shared cost-weighted limiter, which stdio never gets', async () => {
        const { runtime } = harness();
        const first = runtime.depsForRequest(input('ste-a'));
        const second = runtime.depsForRequest(input('ste-b'));

        expect(first.limiter).toBeDefined();
        expect(second.limiter).toBe(first.limiter);

        await runtime.close();
    });

    it('keeps the budget of one principal separate from another', async () => {
        const { runtime } = harness();
        const noisy = runtime.depsForRequest(input('ste-noisy'));
        const quiet = runtime.depsForRequest(input('ste-quiet'));
        const cost = toolCost('browser_scrape');
        const calls = Math.ceil(DEFAULT_RATE_LIMIT_POLICY.burstCapacity / cost);

        for (let call = 0; call < calls; call++) await noisy.limiter?.charge(noisy.principal, 'browser_scrape');
        await expect(noisy.limiter?.charge(noisy.principal, 'browser_scrape')).rejects.toThrow(RATE_LIMIT_NAME);
        await expect(quiet.limiter?.charge(quiet.principal, 'browser_scrape')).resolves.toBeUndefined();

        await runtime.close();
    });
});

describe('HostedRuntime dependency isolation', () => {
    it('reuses clients for one credential but never across credentials', async () => {
        const { runtime, apis, pools } = harness();
        const first = runtime.depsForRequest(input('ste-a'));
        const second = runtime.depsForRequest(input('ste-a'));
        const other = runtime.depsForRequest(input('ste-b'));

        expect(second.api).toBe(first.api);
        expect(second.pool).toBe(first.pool);
        expect(second.registry).toBe(first.registry);
        expect(other.registry).toBe(first.registry);
        expect(other.api).not.toBe(first.api);
        expect(other.pool).not.toBe(first.pool);
        expect(apis.size).toBe(2);
        expect(pools.size).toBe(2);

        await runtime.close();
    });

    it('routes a registry release through the REST client and CDP pool that own the session', async () => {
        const { runtime, apis, pools } = harness();
        const depsA = runtime.depsForRequest(input('ste-a'));
        runtime.depsForRequest(input('ste-b'));

        await depsA.api.createSession({ sessionId: 'steel-a', timeout: 60_000 });
        const record = await depsA.registry.create({
            principal: depsA.principal,
            steelSessionId: 'steel-a',
            expiresAt: Date.now() + 60_000,
        });
        await depsA.registry.release(record.handle, depsA.principal, 'explicit');

        expect(apis.get('ste-a')?.released).toEqual(['steel-a']);
        expect(pools.get('ste-a')?.closed).toEqual(['steel-a']);
        expect(apis.get('ste-b')?.released).toEqual([]);
        expect(pools.get('ste-b')?.closed).toEqual([]);

        await runtime.close();
    });

    it('keeps a handle usable across requests by its owner and opaque to another principal', async () => {
        const { runtime } = harness();
        const owner = runtime.depsForRequest(input('ste-owner'));
        const stranger = runtime.depsForRequest(input('ste-stranger'));
        const record = await owner.registry.create({
            principal: owner.principal,
            steelSessionId: 'steel-owned',
            expiresAt: Date.now() + 60_000,
        });

        await expect(owner.registry.resolve(record.handle, owner.principal)).resolves.toMatchObject({
            steelSessionId: 'steel-owned',
        });
        await expect(stranger.registry.resolve(record.handle, stranger.principal)).rejects.toThrow(
            /No live browser session/
        );

        await runtime.close();
    });

    it('uses a caller credential only as tenant identity for a self-hosted browser', async () => {
        const runtime = new HostedRuntime({
            configForCredential: () =>
                loadConfig({
                    STEEL_LOCAL: 'true',
                    STEEL_BASE_URL: 'http://steel-browser:3000',
                    STEEL_MAX_SESSIONS: '4',
                }),
            createApi: () => new FakeSteelApi(),
            createPool: () => new RecordingPool(),
        });

        const moon = runtime.depsForRequest(input('moon-secret'));

        expect(moon.config.deployment).toBe('self_hosted');
        expect(moon.config.apiKey).toBeUndefined();
        expect(moon.config.maxConcurrentSessions).toBe(4);
        expect(moon.principal).toBe(principalFromCredential('moon-secret'));

        await runtime.close();
    });
});

describe('HostedRuntime over a shared handle store', () => {
    it('releases through this replica own client a session another replica created', async () => {
        const store = new FakeRedis();
        const first = harness({ store });
        const second = harness({ store });

        const creating = first.runtime.depsForRequest(input('ste-a'));
        await creating.api.createSession({ sessionId: 'steel-a', timeout: 60_000 });
        const record = await creating.registry.create({
            principal: creating.principal,
            steelSessionId: 'steel-a',
            expiresAt: Date.now() + 60_000,
        });

        // The release lands on a replica that never saw the create, carrying the same credential.
        const releasing = second.runtime.depsForRequest(input('ste-a'));
        await releasing.registry.release(record.handle, releasing.principal, 'explicit');

        expect(second.apis.get('ste-a')?.released).toEqual(['steel-a']);
        expect(second.pools.get('ste-a')?.closed).toEqual(['steel-a']);
        expect(first.apis.get('ste-a')?.released, 'the creating replica released it twice').toEqual([]);
        expect(await creating.registry.countLive(creating.principal)).toBe(0);

        await first.runtime.close();
        await second.runtime.close();
    });

    it('keeps a record it cannot release, because only a replica with that credential can', async () => {
        // Steel's own inactivity timeout is the guarantee here; our job is not to lose the record.
        const store = new FakeRedis();
        const failures: unknown[] = [];
        const creating = harness({ store });
        const sweeper = harness({ store, onReapError: error => failures.push(error) });

        const deps = creating.runtime.depsForRequest(input('ste-a'));
        await deps.registry.create({
            principal: deps.principal,
            steelSessionId: 'steel-a',
            expiresAt: Date.now() - 1,
        });

        expect(await sweeper.runtime.registry.reap({ idleMs: 1 })).toBe(0);
        expect(failures).toHaveLength(1);
        expect(String(failures[0])).toMatch(/no client for/i);
        expect(await deps.registry.countLive(deps.principal), 'a record was dropped unreleased').toBe(1);

        // The replica that holds the credential still reclaims it on its own sweep.
        expect(await creating.runtime.registry.reap({ idleMs: 1 })).toBe(1);
        expect(creating.apis.get('ste-a')?.released).toEqual(['steel-a']);

        await creating.runtime.close();
        await sweeper.runtime.close();
    });
});

describe('createHandleRegistryBackend', () => {
    /** A shared store is refused without one, so every store-backed case has to carry it. */
    const SHARED_SECRET = { STEEL_REQUEST_STATE_SECRET: 'x'.repeat(48) };

    it('keeps records in this process when no store is configured', async () => {
        const backend = createHandleRegistryBackend({ env: {} });
        const registry = backend.createRegistry({ releaseSteelSession: async () => {} });

        expect(registry).toBeInstanceOf(InMemoryHandleRegistry);
        await backend.close();
    });

    it('shares records through the configured store, so any replica can serve a handle', async () => {
        const store = new FakeRedis();
        let closed = false;
        const backend = createHandleRegistryBackend({
            env: { ...SHARED_SECRET, REDIS_URL: 'redis://cache:6379', REDIS_KEY_PREFIX: 'mcp-test' },
            connect: () => ({
                commands: store,
                close: async () => {
                    closed = true;
                },
            }),
            onError: () => {},
        });

        const deps = { releaseSteelSession: async () => {} };
        const first = backend.createRegistry(deps);
        const second = backend.createRegistry(deps);
        expect(first).toBeInstanceOf(RedisHandleRegistry);

        const principal = principalFromCredential('ste-a');
        const record = await first.create({ principal, steelSessionId: 'steel-a', expiresAt: Date.now() + 60_000 });
        await expect(second.resolve(record.handle, principal)).resolves.toMatchObject({ steelSessionId: 'steel-a' });
        expect(store.valueKeys()).toEqual([`mcp-test:handle:${record.handle}`]);

        await backend.close();
        expect(closed, 'closing the backend left the store connection open').toBe(true);
    });

    it('passes the configured URL to the connector', () => {
        const seen: string[] = [];
        createHandleRegistryBackend({
            env: { ...SHARED_SECRET, REDIS_URL: 'rediss://cache:6380' },
            connect: url => {
                seen.push(url);
                return { commands: new FakeRedis(), close: async () => {} };
            },
            onError: () => {},
        });

        expect(seen).toEqual(['rediss://cache:6380']);
    });

    it('refuses a shared store with no way to report a connection failure', () => {
        // An ioredis client with no error listener takes the whole replica down on a blip.
        expect(() =>
            createHandleRegistryBackend({ env: { ...SHARED_SECRET, REDIS_URL: 'redis://cache:6379' } })
        ).toThrow(/onError/);
    });
});
