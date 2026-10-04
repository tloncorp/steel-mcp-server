// ABOUTME: One behavioural contract run against every handle-registry backend, so the in-memory and
// ABOUTME: Redis implementations cannot drift: field round-trip, authorisation, idle math and release.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SteelToolError } from '../../src/core/errors.js';
import {
    type HandleRegistry,
    InMemoryHandleRegistry,
    principalFromCredential,
    type RegistryDeps,
} from '../../src/core/registry.js';
import { RedisHandleRegistry } from '../../src/core/registry-redis.js';
import { FakeRedis } from '../helpers/fake-redis.js';

const ORG_A = principalFromCredential('ste-key-a');
const ORG_B = principalFromCredential('ste-key-b');

const START_MS = 1_800_000_000_000;

/**
 * The backends every case below runs against.
 *
 * Both are driven through the `HandleRegistry` interface only, so a case can never reach for one
 * backend's internals and quietly stop being a contract.
 */
const BACKENDS = [
    { name: 'InMemoryHandleRegistry', build: (deps: RegistryDeps) => new InMemoryHandleRegistry(deps) },
    {
        name: 'RedisHandleRegistry',
        build: (deps: RegistryDeps) => new RedisHandleRegistry({ ...deps, commands: new FakeRedis() }),
    },
] as const;

/** Moves the one clock both backends read, since the in-memory backend takes `Date.now` directly. */
function advance(deltaMs: number): void {
    vi.setSystemTime(new Date(Date.now() + deltaMs));
}

async function captureError(promise: Promise<unknown>): Promise<SteelToolError> {
    try {
        await promise;
    } catch (error) {
        return error as SteelToolError;
    }
    throw new Error('Expected the promise to reject, but it resolved.');
}

describe.each(BACKENDS)('$name conformance', ({ build }) => {
    let registry: HandleRegistry;
    let released: Array<[string, string]>;
    let releaseFails: (id: string) => boolean;
    let reapErrors: unknown[];

    beforeEach(() => {
        vi.useFakeTimers({ now: START_MS });
        released = [];
        reapErrors = [];
        releaseFails = () => false;
        registry = build({
            releaseSteelSession: async (steelSessionId, principal) => {
                if (releaseFails(steelSessionId)) throw new Error(`steel unreachable for ${steelSessionId}`);
                released.push([steelSessionId, principal]);
            },
            onReapError: error => reapErrors.push(error),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('session capacity reservations', () => {
        it('admits only one concurrent creation at a limit of one', async () => {
            const admitted = await Promise.all(
                Array.from({ length: 5 }, (_, i) =>
                    registry.reserveSessionSlot(ORG_A, `pending-${i}`, Date.now() + 60000, 1)
                )
            );
            expect(admitted.filter(Boolean)).toHaveLength(1);
            await expect(registry.reserveSessionSlot(ORG_B, 'other', Date.now() + 60000, 1)).resolves.toBe(true);
        });
        it('retains capacity until release and counts pre-existing live records', async () => {
            await registry.create({ principal: ORG_A, steelSessionId: 'existing', expiresAt: Date.now() + 60000 });
            await expect(registry.reserveSessionSlot(ORG_A, 'pending', Date.now() + 60000, 1)).resolves.toBe(false);
            await expect(registry.reserveSessionSlot(ORG_A, 'pending', Date.now() + 60000, 2)).resolves.toBe(true);
            const record = await registry.create({
                principal: ORG_A,
                steelSessionId: 'pending',
                expiresAt: Date.now() + 60000,
            });
            await expect(registry.reserveSessionSlot(ORG_A, 'next', Date.now() + 60000, 2)).resolves.toBe(false);
            await registry.release(record.handle, ORG_A, 'explicit');
            await expect(registry.reserveSessionSlot(ORG_A, 'next', Date.now() + 60000, 2)).resolves.toBe(true);
        });
        it('expires abandoned reservations and releases failed creations without freeing another slot', async () => {
            await registry.reserveSessionSlot(ORG_A, 'abandoned', Date.now() + 100, 1);
            await registry.releaseSessionSlot(ORG_A, 'not-the-owner');
            await expect(registry.reserveSessionSlot(ORG_A, 'next', Date.now() + 60000, 1)).resolves.toBe(false);
            advance(100);
            await expect(registry.reserveSessionSlot(ORG_A, 'next', Date.now() + 60000, 1)).resolves.toBe(true);
            await registry.releaseSessionSlot(ORG_A, 'next');
            await expect(registry.reserveSessionSlot(ORG_A, 'retry', Date.now() + 60000, 1)).resolves.toBe(true);
        });
    });

    describe('create and resolve', () => {
        it('round-trips every field a tool reads back off the handle', async () => {
            // debugUrl is the live-player URL the human-in-the-loop handoff elicits with. A backend
            // that drops it turns every login wall into a dead end instead of a handoff.
            const created = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
                viewerUrl: 'https://app.steel.dev/sessions/steel-1',
                inlineViewer: true,
                debugUrl: 'https://api.steel.dev/v1/sessions/steel-1/player',
                mitigation: { useProxy: true, profileId: 'profile-1' },
            });

            const expected = {
                steelSessionId: 'steel-1',
                principal: ORG_A,
                createdAt: START_MS,
                lastUsedAt: START_MS,
                expiresAt: START_MS + 600_000,
                viewerUrl: 'https://app.steel.dev/sessions/steel-1',
                inlineViewer: true,
                debugUrl: 'https://api.steel.dev/v1/sessions/steel-1/player',
                mitigation: { useProxy: true, profileId: 'profile-1' },
                handoffRounds: 0,
            };
            expect(created).toMatchObject(expected);
            expect(await registry.resolve(created.handle, ORG_A)).toMatchObject(expected);
        });

        it('defaults mitigation to an empty state rather than leaving it undefined', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });
            expect((await registry.resolve(handle, ORG_A)).mitigation).toEqual({});
        });

        it('mints an opaque handle that leaks neither the principal nor the Steel session id', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });
            expect(handle.startsWith('sess_')).toBe(true);
            expect(handle).not.toContain(ORG_A);
            expect(handle).not.toContain('steel-1');
        });

        it('answers another principal handle exactly like an unknown one', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });

            const foreign = await captureError(registry.resolve(handle, ORG_B));
            const unknown = await captureError(registry.resolve('sess_nope', ORG_B));
            expect(foreign.code).toBe('not_found');
            expect(foreign.message).toBe(unknown.message);
        });

        it('refuses a handle past its hard expiry with its own code', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 1_000,
            });

            advance(1_000);
            expect((await captureError(registry.resolve(handle, ORG_A))).code).toBe('session_expired');
        });
    });

    describe('touch', () => {
        it('records the last use so idle math measures from it', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });

            advance(5_000);
            await registry.touch(handle);
            expect((await registry.resolve(handle, ORG_A)).lastUsedAt).toBe(START_MS + 5_000);
        });

        it('keeps a touched handle out of an idle sweep', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });

            advance(100_000);
            await registry.touch(handle);
            advance(60_000);

            expect(await registry.reap({ idleMs: 120_000 })).toBe(0);
            expect(released).toEqual([]);
        });

        it('ignores an unknown handle instead of throwing', async () => {
            await expect(registry.touch('sess_nope')).resolves.toBeUndefined();
        });
    });

    describe('awaitInput', () => {
        it('suspends idle reclamation while a person finishes a step', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });
            await registry.awaitInput(handle, Date.now() + 300_000);
            advance(200_000);

            expect(await registry.reap({ idleMs: 120_000 })).toBe(0);
            expect(released).toEqual([]);
        });

        it('never defers past the hard expiry, which stays Steel guarantee alone', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 1_000,
            });
            await registry.awaitInput(handle, Date.now() + 600_000);
            advance(2_000);

            expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
            expect(released).toEqual([['steel-1', ORG_A]]);
        });

        it('frees the slot again once the grace window lapses, so a walked-away human is not free', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 900_000,
            });
            await registry.awaitInput(handle, Date.now() + 60_000);
            advance(120_000);

            expect(await registry.reap({ idleMs: 90_000 })).toBe(1);
        });

        it('resumes normal idle accounting on the next real call', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 900_000,
            });
            await registry.awaitInput(handle, Date.now() + 600_000);
            await registry.touch(handle);
            advance(200_000);

            expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
        });

        it('ignores an unknown handle instead of throwing', async () => {
            await expect(registry.awaitInput('sess_nope', Date.now() + 1_000)).resolves.toBeUndefined();
        });
    });

    describe('recordHandoff', () => {
        async function newHandle(): Promise<string> {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });
            return handle;
        }

        it('starts every handle at no handoffs offered', async () => {
            const handle = await newHandle();
            expect((await registry.resolve(handle, ORG_A)).handoffRounds).toBe(0);
        });

        it('returns the round each handoff is, and reports it back on the record', async () => {
            // The bound has to hold for a client that never returns the signed state, so the count
            // a tool reads is this one rather than anything the caller echoes.
            const handle = await newHandle();

            expect(await registry.recordHandoff(handle)).toBe(1);
            expect(await registry.recordHandoff(handle)).toBe(2);
            expect((await registry.resolve(handle, ORG_A)).handoffRounds).toBe(2);
        });

        it('counts per handle, so one session budget is never spent by another', async () => {
            const first = await newHandle();
            const second = await newHandle();

            await registry.recordHandoff(first);
            await registry.recordHandoff(first);
            expect(await registry.recordHandoff(second)).toBe(1);
            expect((await registry.resolve(first, ORG_A)).handoffRounds).toBe(2);
        });

        it('starts a replacement handle from zero once the first is released', async () => {
            const spent = await newHandle();
            await registry.recordHandoff(spent);
            await registry.release(spent, ORG_A, 'explicit');

            expect((await registry.resolve(await newHandle(), ORG_A)).handoffRounds).toBe(0);
        });

        it('does not throw for a handle it cannot find', async () => {
            // The count of a handle that does not exist is not meaningful, and no caller reaches
            // this without resolving first; what matters is that it is not an error path.
            await expect(registry.recordHandoff('sess_nope')).resolves.toEqual(expect.any(Number));
        });
    });

    describe('release', () => {
        it('releases the Steel session under its owning principal, then forgets the handle', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });

            expect((await registry.release(handle, ORG_A, 'explicit'))?.steelSessionId).toBe('steel-1');
            expect(released).toEqual([['steel-1', ORG_A]]);
            await expect(registry.resolve(handle, ORG_A)).rejects.toBeInstanceOf(SteelToolError);
            expect(await registry.countLive(ORG_A)).toBe(0);
        });

        it('is idempotent: a second release neither throws nor re-releases', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });

            await registry.release(handle, ORG_A, 'explicit');
            expect(await registry.release(handle, ORG_A, 'explicit')).toBeNull();
            expect(released).toHaveLength(1);
            expect(registry.releaseCounts().explicit).toBe(1);
        });

        it('refuses to release another principal handle', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });

            expect((await captureError(registry.release(handle, ORG_B, 'explicit'))).code).toBe('not_found');
            expect(released).toEqual([]);
            expect(await registry.countLive(ORG_A)).toBe(1);
        });

        it('keeps the handle when the Steel release fails, so a retry can still find it', async () => {
            releaseFails = id => id === 'steel-1';
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });

            await expect(registry.release(handle, ORG_A, 'explicit')).rejects.toThrow(/steel unreachable/);
            expect(await registry.countLive(ORG_A), 'the handle was dropped despite the failure').toBe(1);
            expect(registry.releaseCounts().explicit, 'a release that never happened was counted').toBe(0);

            releaseFails = () => false;
            expect(await registry.release(handle, ORG_A, 'explicit')).toBeTruthy();
            expect(registry.releaseCounts().explicit).toBe(1);
        });

        it('counts releases by the path that performed them', async () => {
            const first = await registry.create({
                principal: ORG_A,
                steelSessionId: 's1',
                expiresAt: Date.now() + 600_000,
            });
            const second = await registry.create({
                principal: ORG_A,
                steelSessionId: 's2',
                expiresAt: Date.now() + 600_000,
            });

            await registry.release(first.handle, ORG_A, 'explicit');
            await registry.release(second.handle, ORG_A, 'stream_close');
            expect(registry.releaseCounts()).toEqual({ explicit: 1, stream_close: 1, idle: 0, hard_expiry: 0 });
        });
    });

    describe('list and countLive', () => {
        it('scopes to one principal rather than the whole store', async () => {
            await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: Date.now() + 600_000 });
            await registry.create({ principal: ORG_A, steelSessionId: 's2', expiresAt: Date.now() + 600_000 });
            await registry.create({ principal: ORG_B, steelSessionId: 's3', expiresAt: Date.now() + 600_000 });

            expect(await registry.countLive(ORG_A)).toBe(2);
            expect((await registry.list(ORG_A)).map(record => record.steelSessionId).sort()).toEqual(['s1', 's2']);
            expect((await registry.list(ORG_B)).map(record => record.steelSessionId)).toEqual(['s3']);
        });
    });

    describe('reap', () => {
        it('releases the idle and leaves the fresh alone', async () => {
            const stale = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-stale',
                expiresAt: Date.now() + 900_000,
            });
            advance(200_000);
            const fresh = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-fresh',
                expiresAt: Date.now() + 900_000,
            });

            expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
            expect(released).toEqual([['steel-stale', ORG_A]]);
            await expect(registry.resolve(stale.handle, ORG_A)).rejects.toBeInstanceOf(SteelToolError);
            await expect(registry.resolve(fresh.handle, ORG_A)).resolves.toBeTruthy();
        });

        it('releases a handle past its hard expiry however recently it was used', async () => {
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 1_000,
            });
            advance(2_000);
            await registry.touch(handle);

            expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
            expect(released).toEqual([['steel-1', ORG_A]]);
        });

        it('reports a failed release and keeps sweeping the rest', async () => {
            releaseFails = id => id === 's1';
            await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: Date.now() - 1 });
            await registry.create({ principal: ORG_A, steelSessionId: 's2', expiresAt: Date.now() - 1 });

            expect(await registry.reap({ idleMs: 1 })).toBe(1);
            expect(released).toEqual([['s2', ORG_A]]);
            expect(reapErrors).toHaveLength(1);
            expect(await registry.countLive(ORG_A), 'the unreleasable handle was dropped anyway').toBe(1);
        });

        it('retries on the next sweep the handle whose release failed', async () => {
            releaseFails = () => true;
            await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: Date.now() - 1 });

            expect(await registry.reap({ idleMs: 1 })).toBe(0);
            releaseFails = () => false;
            expect(await registry.reap({ idleMs: 1 })).toBe(1);
            expect(registry.releaseCounts().hard_expiry).toBe(1);
            expect(await registry.countLive(ORG_A)).toBe(0);
        });
    });
});
