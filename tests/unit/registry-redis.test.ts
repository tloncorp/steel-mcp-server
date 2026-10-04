// ABOUTME: Unit tests for the Redis-backed handle registry: the same state machine as the in-memory
// ABOUTME: backend, plus the multi-replica behaviour a shared store adds — handoff and concurrent reaps.
import { describe, expect, it, vi } from 'vitest';
import { SteelToolError } from '../../src/core/errors.js';
import { principalFromCredential, type RegistryDeps } from '../../src/core/registry.js';
import { RedisHandleRegistry } from '../../src/core/registry-redis.js';
import { FakeRedis, GatedRedis } from '../helpers/fake-redis.js';

const ORG_A = principalFromCredential('ste-key-a');
const ORG_B = principalFromCredential('ste-key-b');

/** A movable clock in the `() => Date` shape the rest of the server injects. */
function testClock(startMs = 1_800_000_000_000) {
    let ms = startMs;
    return {
        now: () => new Date(ms),
        advance: (deltaMs: number) => {
            ms += deltaMs;
        },
        get ms() {
            return ms;
        },
    };
}

interface HarnessOptions {
    store?: FakeRedis;
    clock?: ReturnType<typeof testClock>;
    releaseSteelSession?: RegistryDeps['releaseSteelSession'];
    onReapError?: RegistryDeps['onReapError'];
}

/** Builds one replica. Pass the same store and clock twice to model two replicas of one deployment. */
function harness(options: HarnessOptions = {}) {
    const clock = options.clock ?? testClock();
    const store = options.store ?? new FakeRedis({ now: clock.now });
    const released: string[] = [];
    const registry = new RedisHandleRegistry({
        commands: store,
        now: clock.now,
        releaseSteelSession:
            options.releaseSteelSession ??
            (async (id: string) => {
                released.push(id);
            }),
        onReapError: options.onReapError,
    });
    return { registry, store, clock, released };
}

async function captureError(promise: Promise<unknown>): Promise<SteelToolError> {
    try {
        await promise;
    } catch (error) {
        return error as SteelToolError;
    }
    throw new Error('Expected the promise to reject, but it resolved.');
}

describe('RedisHandleRegistry.create', () => {
    it('mints an opaque prefixed handle with at least 128 bits of entropy', async () => {
        const { registry, clock } = harness();
        const record = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });
        expect(record.handle.startsWith('sess_')).toBe(true);
        expect(record.handle.length - 'sess_'.length).toBeGreaterThanOrEqual(22);
    });

    it('never derives the handle from the principal or the Steel id', async () => {
        const { registry, clock } = harness();
        const handles = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const record = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: clock.ms + 60_000,
            });
            expect(record.handle).not.toContain(ORG_A);
            expect(record.handle).not.toContain('steel-1');
            handles.add(record.handle);
        }
        expect(handles.size).toBe(50);
    });

    it('stores the record under a key namespaced by prefix and principal', async () => {
        const clock = testClock();
        const store = new FakeRedis({ now: clock.now });
        const registry = new RedisHandleRegistry({
            commands: store,
            keyPrefix: 'tenant-x',
            now: clock.now,
            releaseSteelSession: async () => {},
        });
        const record = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        expect(store.valueKeys()).toEqual([`tenant-x:handle:${record.handle}`]);
        expect(store.setMembers()[`tenant-x:principal:${ORG_A}`]).toEqual([record.handle]);
        expect(store.setMembers()['tenant-x:live']).toEqual([`${ORG_A}:${record.handle}`]);
    });

    it('keeps the record alive well past the hard expiry, so a failed release can still be retried', async () => {
        const { registry, store, clock } = harness();
        const expiresIn = 60_000;
        await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + expiresIn,
        });

        const [key] = store.valueKeys();
        expect(store.ttlMs(key!)).toBeGreaterThan(expiresIn);
    });

    it('still gives a long-expired handle a positive expiry, which is the only kind Redis accepts', async () => {
        const { registry, store, clock } = harness();
        await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms - 30 * 86_400_000,
        });

        const [key] = store.valueKeys();
        expect(store.ttlMs(key!)).toBeGreaterThan(0);
    });
});

describe('RedisHandleRegistry human control', () => {
    it('shares an exclusive fencing lease across replicas', async () => {
        const clock = testClock();
        const store = new FakeRedis({ now: clock.now });
        const first = harness({ clock, store }).registry;
        const second = harness({ clock, store }).registry;
        const { handle } = await first.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: clock.ms + 600_000,
        });

        const lease = await first.acquireHumanControl(handle, ORG_A, 60_000);
        await expect(second.acquireHumanControl(handle, ORG_A, 60_000)).rejects.toMatchObject({
            code: 'human_control_active',
        });
        await expect(second.resolveForAgent(handle, ORG_A)).rejects.toMatchObject({
            code: 'human_control_active',
        });
        const renewed = await second.renewHumanControl(handle, ORG_A, lease.token, 60_000);
        await second.releaseHumanControl(handle, ORG_A, renewed.token);
        await expect(first.resolveForAgent(handle, ORG_A)).resolves.toMatchObject({ handle });
    });

    it('lets an expired viewer lease disappear without a cleanup call', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: clock.ms + 600_000,
        });
        await registry.acquireHumanControl(handle, ORG_A, 60_000);
        clock.advance(60_001);
        await expect(registry.resolveForAgent(handle, ORG_A)).resolves.toMatchObject({ handle });
    });

    it('shares the release fence before an external release completes', async () => {
        const clock = testClock();
        const store = new FakeRedis({ now: clock.now });
        let finish!: () => void;
        let started!: () => void;
        const releasing = new Promise<void>(resolve => (started = resolve));
        const gate = new Promise<void>(resolve => (finish = resolve));
        const first = harness({
            clock,
            store,
            releaseSteelSession: async () => {
                started();
                await gate;
            },
        }).registry;
        const second = harness({ clock, store }).registry;
        const { handle } = await first.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: clock.ms + 600_000,
        });

        const pending = first.release(handle, ORG_A, 'explicit');
        await releasing;
        await expect(second.resolveForAgent(handle, ORG_A)).rejects.toMatchObject({ code: 'session_releasing' });
        await expect(second.acquireHumanControl(handle, ORG_A, 60_000)).rejects.toMatchObject({
            code: 'session_releasing',
        });
        finish();
        await pending;
    });
});

describe('RedisHandleRegistry.resolve', () => {
    it('returns the record for the principal that created it', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
            viewerUrl: 'https://app.steel.dev/sessions/steel-1',
            mitigation: { useProxy: true },
        });

        await expect(registry.resolve(handle, ORG_A)).resolves.toMatchObject({
            steelSessionId: 'steel-1',
            principal: ORG_A,
            viewerUrl: 'https://app.steel.dev/sessions/steel-1',
            mitigation: { useProxy: true },
        });
    });

    it('rejects a handle presented by a different principal', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        const error = await captureError(registry.resolve(handle, ORG_B));
        expect(error).toBeInstanceOf(SteelToolError);
        expect(error.code).toBe('not_found');
    });

    it('does not reveal whether a rejected handle exists', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        const wrongOrg = await registry.resolve(handle, ORG_B).catch(e => (e as Error).message);
        const unknown = await registry.resolve('sess_nope', ORG_B).catch(e => (e as Error).message);
        expect(wrongOrg).toBe(unknown);
    });

    it('rejects an expired handle with its own code', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 1_000,
        });

        clock.advance(2_000);
        const error = await captureError(registry.resolve(handle, ORG_A));
        expect(error.code).toBe('session_expired');
    });

    it('treats an unreadable record as an unknown handle rather than throwing a parse error', async () => {
        const { registry, store, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });
        const [key] = store.valueKeys();
        await store.set(key!, 'not json', 60_000);

        const error = await captureError(registry.resolve(handle, ORG_A));
        expect(error.code).toBe('not_found');
    });
});

describe('RedisHandleRegistry.touch', () => {
    it('records the last use so the reaper can measure idleness', async () => {
        const { registry, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 600_000,
        });

        const before = (await registry.resolve(handle, ORG_A)).lastUsedAt;
        clock.advance(5_000);
        await registry.touch(handle);

        expect((await registry.resolve(handle, ORG_A)).lastUsedAt).toBe(before + 5_000);
    });

    it('ignores an unknown handle', async () => {
        const { registry } = harness();
        await expect(registry.touch('sess_nope')).resolves.toBeUndefined();
    });
});

describe('RedisHandleRegistry.release', () => {
    it.each([
        ['explicit', 'capacity'],
        ['explicit', 'profile-writer'],
        ['reap', 'capacity'],
        ['reap', 'profile-writer'],
    ] as const)('retains retryable records when %s cleanup fails in %s', async (path, ledger) => {
        const errors: unknown[] = [];
        const { registry, store, clock } = harness({ onReapError: error => errors.push(error) });
        const until = clock.ms + 60_000;
        await registry.reserveSessionSlot(ORG_A, 'steel-1', until, 1);
        await registry.reserveProfileWriter(ORG_A, 'profile-1', 'steel-1', until);
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: until,
            mitigation: { persistProfile: true, profileId: 'profile-1' },
        });
        const original = store.compareDelete.bind(store);
        let fail = true;
        vi.spyOn(store, 'compareDelete').mockImplementation(async (key, expected) => {
            if (fail && key.includes(`:${ledger}:`)) {
                fail = false;
                throw new Error('transient ledger failure');
            }
            return original(key, expected);
        });

        if (path === 'explicit') {
            await expect(registry.release(handle, ORG_A, 'explicit')).rejects.toThrow('transient ledger failure');
        } else {
            expect(await registry.reap({ idleMs: 0 })).toBe(0);
            expect(errors).toHaveLength(1);
        }
        const remaining = await registry.list(ORG_A);
        expect(remaining).toHaveLength(1);
        expect(remaining[0]?.releasing).toBeFalsy();
        expect(registry.releaseCounts()).toEqual({ explicit: 0, stream_close: 0, idle: 0, hard_expiry: 0 });

        // A different replica can finish immediately, without waiting for either ledger's TTL.
        const retry = harness({ store, clock }).registry;
        expect(await retry.reap({ idleMs: 0 })).toBe(1);
        expect(retry.releaseCounts().idle).toBe(1);
        expect(await retry.list(ORG_A)).toEqual([]);
        expect(store.valueKeys()).toEqual([]);
        expect(store.setMembers()).toEqual({});
        expect(await retry.reserveSessionSlot(ORG_A, 'steel-2', until, 1)).toBe(true);
        expect(await retry.reserveProfileWriter(ORG_A, 'profile-1', 'steel-2', until)).toBe(true);
    });

    it('releases the Steel session and forgets the handle, indexes included', async () => {
        const { registry, store, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        const record = await registry.release(handle, ORG_A, 'explicit');
        expect(record?.steelSessionId).toBe('steel-1');
        expect(released).toEqual(['steel-1']);
        expect(await registry.countLive(ORG_A)).toBe(0);
        expect(store.valueKeys()).toEqual([]);
        expect(store.setMembers()).toEqual({});
    });

    it('names the owning principal, so a hosted replica can pick the credential allowed to release', async () => {
        const releases: Array<[string, string]> = [];
        const clock = testClock();
        const registry = new RedisHandleRegistry({
            commands: new FakeRedis({ now: clock.now }),
            now: clock.now,
            releaseSteelSession: async (id: string, principal: string) => {
                releases.push([id, principal]);
            },
        });
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        await registry.release(handle, ORG_A, 'explicit');
        expect(releases).toEqual([['steel-1', ORG_A]]);
    });

    it('is idempotent: a second release neither throws nor re-releases', async () => {
        const { registry, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        await registry.release(handle, ORG_A, 'explicit');
        await expect(registry.release(handle, ORG_A, 'explicit')).resolves.toBeNull();
        expect(released).toEqual(['steel-1']);
        expect(registry.releaseCounts().explicit).toBe(1);
    });

    it('refuses to release another principal handle', async () => {
        const { registry, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        await expect(registry.release(handle, ORG_B, 'explicit')).rejects.toBeInstanceOf(SteelToolError);
        expect(released).toEqual([]);
        expect(await registry.countLive(ORG_A)).toBe(1);
    });

    it('releases the Steel session before forgetting the handle', async () => {
        // If the record went first, a transient failure would lose it: no retry, the reaper could
        // never see it, and the browser would bill on with nothing tracking it.
        let resolvableDuringRelease: boolean | undefined;
        const clock = testClock();
        const store = new FakeRedis({ now: clock.now });
        const registry: RedisHandleRegistry = new RedisHandleRegistry({
            commands: store,
            now: clock.now,
            releaseSteelSession: async () => {
                resolvableDuringRelease = await registry
                    .resolve(handle, ORG_A)
                    .then(() => true)
                    .catch(() => false);
            },
        });
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: clock.ms + 60_000,
        });

        await registry.release(handle, ORG_A, 'explicit');
        expect(resolvableDuringRelease, 'the record was deleted before the release was awaited').toBe(true);
    });

    it('keeps the handle when the Steel release fails, so the reaper can retry', async () => {
        let attempts = 0;
        const { registry, clock } = harness({
            releaseSteelSession: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('steel unreachable');
            },
        });
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: clock.ms + 60_000,
        });

        await expect(registry.release(handle, ORG_A, 'explicit')).rejects.toThrow(/steel unreachable/);
        expect(await registry.countLive(ORG_A), 'the handle was dropped despite the failure').toBe(1);
        expect(registry.releaseCounts().explicit, 'the leak metric counted a release that never happened').toBe(0);

        await expect(registry.release(handle, ORG_A, 'explicit')).resolves.toBeTruthy();
        expect(await registry.countLive(ORG_A)).toBe(0);
        expect(registry.releaseCounts().explicit).toBe(1);
    });
});

describe('RedisHandleRegistry.reap', () => {
    it('releases handles idle past the deadline and leaves fresh ones alone', async () => {
        const { registry, clock, released } = harness();
        const stale = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-stale',
            expiresAt: clock.ms + 600_000,
        });
        clock.advance(200_000);
        const fresh = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-fresh',
            expiresAt: clock.ms + 600_000,
        });

        expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
        expect(released).toEqual(['steel-stale']);
        await expect(registry.resolve(stale.handle, ORG_A)).rejects.toBeInstanceOf(SteelToolError);
        await expect(registry.resolve(fresh.handle, ORG_A)).resolves.toBeTruthy();
    });

    it('releases handles past their hard expiry regardless of recent use', async () => {
        const { registry, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 1_000,
        });
        clock.advance(2_000);
        await registry.touch(handle);

        expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
        expect(released).toEqual(['steel-1']);
    });

    it('counts releases by path so the Steel backstop can be alerted on', async () => {
        const { registry, clock } = harness();
        const a = await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms + 60_000 });
        const b = await registry.create({ principal: ORG_A, steelSessionId: 's2', expiresAt: clock.ms + 60_000 });
        await registry.release(a.handle, ORG_A, 'explicit');
        await registry.release(b.handle, ORG_A, 'stream_close');

        expect(registry.releaseCounts()).toMatchObject({ explicit: 1, stream_close: 1, idle: 0, hard_expiry: 0 });
    });

    it('keeps releasing after one release fails, and reports the failure', async () => {
        const failures: unknown[] = [];
        const { registry, clock } = harness({
            releaseSteelSession: async (id: string) => {
                if (id === 's1') throw new Error('steel unreachable');
            },
            onReapError: error => failures.push(error),
        });
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms - 1 });
        await registry.create({ principal: ORG_A, steelSessionId: 's2', expiresAt: clock.ms - 1 });

        expect(await registry.reap({ idleMs: 1 })).toBe(1);
        expect(failures).toHaveLength(1);
        expect((failures[0] as Error).message).toContain('steel unreachable');
    });

    it('retries a handle whose release failed on the previous sweep', async () => {
        let attempts = 0;
        const { registry, clock } = harness({
            releaseSteelSession: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('steel unreachable');
            },
            onReapError: () => {},
        });
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms - 1 });

        expect(await registry.reap({ idleMs: 1 })).toBe(0);
        expect(await registry.countLive(ORG_A), 'a failed reap dropped the handle it could not release').toBe(1);

        expect(await registry.reap({ idleMs: 1 })).toBe(1);
        expect(await registry.countLive(ORG_A)).toBe(0);
        expect(registry.releaseCounts().hard_expiry).toBe(1);
    });

    it('sweeps a member no registry wrote, instead of carrying it through every future sweep', async () => {
        const { registry, store, released } = harness();
        await store.sadd('steel-mcp:live', 'not-a-member');

        expect(await registry.reap({ idleMs: 1 })).toBe(0);
        expect(released).toEqual([]);
        expect(store.setMembers()).toEqual({});
    });

    it('sweeps an index entry whose record is already gone', async () => {
        const { registry, store, clock, released } = harness();
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms + 60_000 });
        const [key] = store.valueKeys();
        await store.del(key!);

        expect(await registry.reap({ idleMs: 1 })).toBe(0);
        expect(released, 'a record-less index entry named no Steel session to release').toEqual([]);
        expect(store.setMembers()).toEqual({});
    });
});

describe('RedisHandleRegistry.countLive', () => {
    it('counts per principal, not globally', async () => {
        const { registry, clock } = harness();
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms + 60_000 });
        await registry.create({ principal: ORG_B, steelSessionId: 's2', expiresAt: clock.ms + 60_000 });

        expect(await registry.countLive(ORG_A)).toBe(1);
        expect(await registry.countLive(ORG_B)).toBe(1);
        expect(await registry.list(ORG_A)).toHaveLength(1);
    });

    it('does not count a handle whose record another replica already released', async () => {
        const { registry, store, clock } = harness();
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: clock.ms + 60_000 });
        const [key] = store.valueKeys();
        await store.del(key!);

        expect(await registry.countLive(ORG_A)).toBe(0);
        expect(store.setMembers(), 'the stale index entry survived a list').toEqual({});
    });
});

describe('RedisHandleRegistry.recordHandoff', () => {
    it('gives the counter an expiry, which an increment on its own would not', async () => {
        // INCR creates its key with no TTL at all, so without the explicit expiry the counter for
        // every handle a deployment ever mints would sit in Redis for good.
        const { registry, store, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 600_000,
        });

        await registry.recordHandoff(handle);

        const ttl = store.ttlMs(`steel-mcp:handle:${handle}:rounds`);
        expect(ttl, 'the counter key was never given an expiry').toBeLessThan(Number.POSITIVE_INFINITY);
        expect(ttl).toBeGreaterThan(0);
    });

    it('is swept with the handle, so a released session leaves no counter behind', async () => {
        const { registry, store, clock } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 600_000,
        });
        await registry.recordHandoff(handle);

        await registry.release(handle, ORG_A, 'explicit');
        expect(store.valueKeys()).toEqual([]);
    });
});

describe('RedisHandleRegistry across replicas', () => {
    /** Two registries over one store: exactly the hosted shape, where no request is routed stickily. */
    function twoReplicas(options: HarnessOptions = {}) {
        const clock = options.clock ?? testClock();
        const store = options.store ?? new FakeRedis({ now: clock.now });
        const first = harness({ ...options, store, clock });
        const second = harness({ ...options, store, clock });
        return { first, second, store, clock };
    }

    it('resolves on a second replica a handle the first one created', async () => {
        const { first, second, clock } = twoReplicas();
        const { handle } = await first.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        await expect(second.registry.resolve(handle, ORG_A)).resolves.toMatchObject({ steelSessionId: 'steel-1' });
        expect(await second.registry.countLive(ORG_A)).toBe(1);
    });

    it('keeps a handle opaque to another principal on every replica', async () => {
        const { first, second, clock } = twoReplicas();
        const { handle } = await first.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        const error = await captureError(second.registry.resolve(handle, ORG_B));
        expect(error.code).toBe('not_found');
        expect(await second.registry.countLive(ORG_B)).toBe(0);
    });

    it('counts handoff rounds as one sequence however the calls are routed', async () => {
        // The bound is per handle, not per replica. A per-process count would restart on whichever
        // replica had not seen the handle, and a person would be interrupted again for free.
        const { first, second, clock } = twoReplicas();
        const { handle } = await first.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 900_000,
        });

        expect(await first.registry.recordHandoff(handle)).toBe(1);
        expect(await second.registry.recordHandoff(handle), 'the second replica started its own count').toBe(2);
        expect(await first.registry.recordHandoff(handle)).toBe(3);

        // Whichever replica serves the next retry reads the same total and stops offering.
        expect((await first.registry.resolve(handle, ORG_A)).handoffRounds).toBe(3);
        expect((await second.registry.resolve(handle, ORG_A)).handoffRounds).toBe(3);
    });

    it('carries a touch on one replica over to the other replica idle math', async () => {
        const { first, second, clock } = twoReplicas();
        const { handle } = await first.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 600_000,
        });

        clock.advance(100_000);
        await second.registry.touch(handle);
        clock.advance(60_000);

        expect(await first.registry.reap({ idleMs: 120_000 }), 'a touch on another replica was not seen').toBe(0);
    });

    it('is idempotent across replicas: releasing on one leaves nothing for the other', async () => {
        const { first, second, clock } = twoReplicas();
        const { handle } = await first.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 60_000,
        });

        await first.registry.release(handle, ORG_A, 'explicit');
        await expect(second.registry.release(handle, ORG_A, 'explicit')).resolves.toBeNull();
        expect(first.released).toEqual(['steel-1']);
        expect(second.released, 'the second replica released a session the first had already released').toEqual([]);
    });

    it('does not let a touch already in flight put back a handle another replica released', async () => {
        // A resurrected record is worse than a leaked key: `release` has already removed both index
        // entries, so nothing lists it and no sweep on any replica will ever visit it again, while
        // it keeps resolving as a live handle whose browser Steel has already torn down.
        const clock = testClock();
        const store = new FakeRedis({ now: clock.now });
        const gated = new GatedRedis(store);
        const releasing = harness({ store, clock });
        const touching = new RedisHandleRegistry({
            commands: gated,
            now: clock.now,
            releaseSteelSession: async () => {},
        });
        const { handle } = await releasing.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 600_000,
        });

        // The touch sees a live handle, and is caught before it has finished writing.
        gated.hold(1);
        const pending = touching.touch(handle);
        expect(await releasing.registry.release(handle, ORG_A, 'explicit')).toBeTruthy();
        gated.release();
        await pending;

        const error = await captureError(releasing.registry.resolve(handle, ORG_A));
        expect(error.code, 'the released handle resolved again').toBe('not_found');
        expect(await releasing.registry.list(ORG_A)).toEqual([]);
        expect(await releasing.registry.reap({ idleMs: 0 })).toBe(0);
        expect(releasing.released, 'the session was released twice').toEqual(['steel-1']);
        // Nothing that could be read back as a handle survives: the release swept the last-use key
        // the touch had already written, and one written after a sweep expires on its own.
        expect(store.valueKeys()).not.toContain(`steel-mcp:handle:${handle}`);
    });

    it('counts one release when two replicas sweep the same handle at once', async () => {
        // Atomic SET-NX release fencing admits one sweep; the loser neither releases nor counts.
        const { first, second, store, clock } = twoReplicas();
        await first.registry.create({ principal: ORG_A, steelSessionId: 'steel-1', expiresAt: clock.ms + 600_000 });
        clock.advance(200_000);

        const [reapedByFirst, reapedBySecond] = await Promise.all([
            first.registry.reap({ idleMs: 120_000 }),
            second.registry.reap({ idleMs: 120_000 }),
        ]);

        expect([...first.released, ...second.released]).toEqual(['steel-1']);
        expect(reapedByFirst + reapedBySecond, 'the same handle was reaped twice').toBe(1);
        const counts = first.registry.releaseCounts().idle + second.registry.releaseCounts().idle;
        expect(counts, 'two replicas both counted the one release').toBe(1);
        expect(store.valueKeys()).toEqual([]);
        expect(store.setMembers()).toEqual({});
        expect(await first.registry.countLive(ORG_A)).toBe(0);
    });

    it('leaves nothing behind when every replica sweeps a whole store', async () => {
        const { first, second, store, clock } = twoReplicas();
        for (const id of ['s1', 's2', 's3']) {
            await first.registry.create({ principal: ORG_A, steelSessionId: id, expiresAt: clock.ms + 600_000 });
        }
        await second.registry.create({ principal: ORG_B, steelSessionId: 's4', expiresAt: clock.ms + 600_000 });
        clock.advance(200_000);

        const swept = await Promise.all([
            first.registry.reap({ idleMs: 120_000 }),
            second.registry.reap({ idleMs: 120_000 }),
        ]);

        // Every session is released, each counted exactly once across the fleet. A replica may ask
        // Steel to release a session another replica had already released; that call is idempotent,
        // which is why concurrent sweeps need no coordination.
        expect(swept[0] + swept[1]).toBe(4);
        expect([...new Set([...first.released, ...second.released])].sort()).toEqual(['s1', 's2', 's3', 's4']);
        expect(first.registry.releaseCounts().idle + second.registry.releaseCounts().idle).toBe(4);
        expect(store.valueKeys()).toEqual([]);
        expect(store.setMembers()).toEqual({});
    });
});

describe('RedisHandleRegistry.awaitInput', () => {
    it('suspends idle reclamation while a person finishes a step in the live session', async () => {
        const { registry, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 600_000,
        });
        await registry.awaitInput(handle, clock.ms + 300_000);
        clock.advance(200_000);

        expect(await registry.reap({ idleMs: 120_000 })).toBe(0);
        expect(released).toEqual([]);
    });

    it('still reaps a handle awaiting human input once its hard expiry passes', async () => {
        // The grace window suspends our slot reclamation only. The hard timeout is Steel's, and
        // nothing about a pending elicitation may extend it.
        const { registry, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 1_000,
        });
        await registry.awaitInput(handle, clock.ms + 600_000);
        clock.advance(2_000);

        expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
        expect(released).toEqual(['steel-1']);
    });

    it('reaps a handle again once its grace window lapses, so a walked-away human frees the slot', async () => {
        const { registry, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 900_000,
        });
        await registry.awaitInput(handle, clock.ms + 60_000);
        clock.advance(120_000);

        expect(await registry.reap({ idleMs: 90_000 })).toBe(1);
        expect(released).toEqual(['steel-1']);
    });

    it('clears the grace window on the next real call, so normal idle accounting resumes', async () => {
        const { registry, clock, released } = harness();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 900_000,
        });
        await registry.awaitInput(handle, clock.ms + 600_000);
        await registry.touch(handle);
        clock.advance(200_000);

        expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
        expect(released).toEqual(['steel-1']);
    });

    it('does not roll back a touch that landed while the handoff was being registered', async () => {
        // The write that lost this update was a whole-record rewrite built from a read taken before
        // the touch. Both operations now write only the one key they own, so neither can undo the
        // other, and the order they settle in stops mattering.
        const clock = testClock();
        const store = new FakeRedis({ now: clock.now });
        const gated = new GatedRedis(store);
        const touching = harness({ store, clock });
        const awaiting = new RedisHandleRegistry({
            commands: gated,
            now: clock.now,
            releaseSteelSession: async () => {},
        });
        const { handle } = await touching.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 900_000,
        });

        clock.advance(100_000);
        // Whatever the handoff reads, it reads before the touch; whatever it writes, it writes after.
        gated.hold(1);
        const pending = awaiting.awaitInput(handle, clock.ms + 60_000);
        await touching.registry.touch(handle);
        const touchedAt = clock.ms;
        gated.release();
        await pending;

        const record = await touching.registry.resolve(handle, ORG_A);
        expect(record.lastUsedAt, 'the handoff write rolled the last use back to before the touch').toBe(touchedAt);

        // The consequence of that rollback: idleness measured from the older timestamp reclaims the
        // slot while the session is in active use.
        clock.advance(90_000);
        expect(await touching.registry.reap({ idleMs: 120_000 })).toBe(0);
        expect(touching.released).toEqual([]);
    });

    it('defers the other replica reaper too, because the mark lives in the shared record', async () => {
        const clock = testClock();
        const store = new FakeRedis({ now: clock.now });
        const first = harness({ store, clock });
        const second = harness({ store, clock });
        const { handle } = await first.registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: clock.ms + 600_000,
        });
        await first.registry.awaitInput(handle, clock.ms + 300_000);
        clock.advance(200_000);

        expect(await second.registry.reap({ idleMs: 120_000 })).toBe(0);
        expect(second.released).toEqual([]);
    });
});
