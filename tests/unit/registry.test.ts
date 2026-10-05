// ABOUTME: Unit tests for the handle registry state machine: opaque handle minting, per-call
// ABOUTME: re-authorisation against the caller's own principal, idempotent release and the reaper.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SteelToolError } from '../../src/core/errors.js';
import { InMemoryHandleRegistry, principalFromCredential } from '../../src/core/registry.js';

const ORG_A = principalFromCredential('ste-key-a');
const ORG_B = principalFromCredential('ste-key-b');

function newRegistry() {
    const released: string[] = [];
    const registry = new InMemoryHandleRegistry({
        releaseSteelSession: async (id: string) => {
            released.push(id);
        },
    });
    return { registry, released };
}

/** Awaits a rejection and returns it typed, so assertions do not fight the success-type union. */
async function captureError(promise: Promise<unknown>): Promise<SteelToolError> {
    try {
        await promise;
    } catch (error) {
        return error as SteelToolError;
    }
    throw new Error('Expected the promise to reject, but it resolved.');
}

describe('principalFromCredential', () => {
    it('is stable for one credential and different across credentials', () => {
        expect(principalFromCredential('ste-key-a')).toBe(principalFromCredential('ste-key-a'));
        expect(ORG_A).not.toBe(ORG_B);
    });

    it('does not contain the credential', () => {
        expect(principalFromCredential('ste-supersecret')).not.toContain('supersecret');
    });
});

describe('profile writer reservations', () => {
    it('fences concurrent writers and lets only the owner release the reservation', async () => {
        const { registry } = newRegistry();
        const until = Date.now() + 60_000;
        await expect(registry.reserveProfileWriter(ORG_A, 'profile-1', 'owner-1', until)).resolves.toBe(true);
        await expect(registry.reserveProfileWriter(ORG_A, 'profile-1', 'owner-2', until)).resolves.toBe(false);
        await registry.releaseProfileWriter(ORG_A, 'profile-1', 'owner-2');
        await expect(registry.reserveProfileWriter(ORG_A, 'profile-1', 'owner-2', until)).resolves.toBe(false);
        await registry.releaseProfileWriter(ORG_A, 'profile-1', 'owner-1');
        await expect(registry.reserveProfileWriter(ORG_A, 'profile-1', 'owner-2', until)).resolves.toBe(true);
    });
});

describe('InMemoryHandleRegistry.create', () => {
    it('mints an opaque prefixed handle with at least 128 bits of entropy', async () => {
        const { registry } = newRegistry();
        const record = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: Date.now() + 60_000,
        });
        expect(record.handle.startsWith('sess_')).toBe(true);
        // base64url of 16 bytes is 22 characters.
        expect(record.handle.length - 'sess_'.length).toBeGreaterThanOrEqual(22);
    });

    it('never derives the handle from the principal, the Steel id or the clock', async () => {
        const { registry } = newRegistry();
        const handles = new Set<string>();
        for (let i = 0; i < 200; i++) {
            const record = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 60_000,
            });
            expect(record.handle).not.toContain(ORG_A);
            expect(record.handle).not.toContain('steel-1');
            handles.add(record.handle);
        }
        expect(handles.size).toBe(200);
    });
});

describe('InMemoryHandleRegistry.resolve', () => {
    let registry: InMemoryHandleRegistry;
    let handle: string;

    beforeEach(async () => {
        registry = newRegistry().registry;
        handle = (
            await registry.create({ principal: ORG_A, steelSessionId: 'steel-1', expiresAt: Date.now() + 60_000 })
        ).handle;
    });

    it('returns the record for the principal that created it', async () => {
        const record = await registry.resolve(handle, ORG_A);
        expect(record.steelSessionId).toBe('steel-1');
    });

    it('rejects a handle presented by a different principal', async () => {
        const error = await captureError(registry.resolve(handle, ORG_B));
        expect(error).toBeInstanceOf(SteelToolError);
        expect(error.code).toBe('not_found');
    });

    it('does not reveal whether a rejected handle exists', async () => {
        const wrongOrg = await registry.resolve(handle, ORG_B).catch(e => (e as Error).message);
        const unknown = await registry.resolve('sess_nope', ORG_B).catch(e => (e as Error).message);
        expect(wrongOrg).toBe(unknown);
    });

    it('rejects an expired handle with its own code', async () => {
        vi.useFakeTimers();
        try {
            const expiring = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-2',
                expiresAt: Date.now() + 1_000,
            });
            vi.advanceTimersByTime(2_000);
            const error = await captureError(registry.resolve(expiring.handle, ORG_A));
            expect(error.code).toBe('session_expired');
        } finally {
            vi.useRealTimers();
        }
    });

    it('records the last use so the reaper can measure idleness', async () => {
        vi.useFakeTimers();
        try {
            const before = (await registry.resolve(handle, ORG_A)).lastUsedAt;
            vi.advanceTimersByTime(5_000);
            await registry.touch(handle);
            expect((await registry.resolve(handle, ORG_A)).lastUsedAt).toBeGreaterThan(before);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('InMemoryHandleRegistry.release', () => {
    it('releases the Steel session and forgets the handle', async () => {
        const { registry, released } = newRegistry();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: Date.now() + 60_000,
        });
        const record = await registry.release(handle, ORG_A, 'explicit');
        expect(record?.steelSessionId).toBe('steel-1');
        expect(released).toEqual(['steel-1']);
        expect(await registry.countLive(ORG_A)).toBe(0);
    });

    it('names the owning principal, so a hosted replica can pick the credential allowed to release', async () => {
        // A replica that did not create the session has no other way to find the right Steel client.
        const releases: Array<[string, string]> = [];
        const registry = new InMemoryHandleRegistry({
            releaseSteelSession: async (id: string, principal: string) => {
                releases.push([id, principal]);
            },
        });
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: Date.now() + 60_000,
        });

        await registry.release(handle, ORG_A, 'explicit');
        expect(releases).toEqual([['steel-1', ORG_A]]);
    });

    it('is idempotent: a second release neither throws nor re-releases', async () => {
        const { registry, released } = newRegistry();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: Date.now() + 60_000,
        });
        await registry.release(handle, ORG_A, 'explicit');
        await expect(registry.release(handle, ORG_A, 'explicit')).resolves.toBeNull();
        expect(released).toEqual(['steel-1']);
    });

    it('refuses to release another principal handle', async () => {
        const { registry, released } = newRegistry();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: Date.now() + 60_000,
        });
        await expect(registry.release(handle, ORG_B, 'explicit')).rejects.toBeInstanceOf(SteelToolError);
        expect(released).toEqual([]);
        expect(await registry.countLive(ORG_A)).toBe(1);
    });
});

describe('InMemoryHandleRegistry human control', () => {
    it('fences agent page operations until the owning viewer hands control back', async () => {
        const { registry } = newRegistry();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 'steel-1',
            expiresAt: Date.now() + 600_000,
        });

        const lease = await registry.acquireHumanControl(handle, ORG_A, 60_000);
        const blocked = await captureError(registry.resolveForAgent(handle, ORG_A));
        expect(blocked.code).toBe('human_control_active');

        await expect(registry.releaseHumanControl(handle, ORG_A, 'wrong-token')).rejects.toMatchObject({
            code: 'human_control_active',
        });
        await registry.releaseHumanControl(handle, ORG_A, lease.token);
        await expect(registry.resolveForAgent(handle, ORG_A)).resolves.toMatchObject({ handle });
    });

    it('renews only the current fencing token and never beyond hard expiry', async () => {
        vi.useFakeTimers();
        try {
            const { registry } = newRegistry();
            const expiresAt = Date.now() + 70_000;
            const { handle } = await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt });
            const lease = await registry.acquireHumanControl(handle, ORG_A, 60_000);
            vi.advanceTimersByTime(20_000);
            const renewed = await registry.renewHumanControl(handle, ORG_A, lease.token, 60_000);
            expect(renewed.leaseUntil).toBe(expiresAt);
            await expect(registry.renewHumanControl(handle, ORG_A, 'stale', 60_000)).rejects.toMatchObject({
                code: 'human_control_active',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not reap active human control, but hard expiry still wins', async () => {
        vi.useFakeTimers();
        try {
            const { registry, released } = newRegistry();
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 's1',
                expiresAt: Date.now() + 90_000,
            });
            await registry.acquireHumanControl(handle, ORG_A, 60_000);
            vi.advanceTimersByTime(40_000);
            expect(await registry.reap({ idleMs: 30_000 })).toBe(0);
            vi.advanceTimersByTime(51_000);
            expect(await registry.reap({ idleMs: 30_000 })).toBe(1);
            expect(released).toEqual(['s1']);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('InMemoryHandleRegistry.release ordering', () => {
    it('releases the Steel session before forgetting the handle', async () => {
        // If the record went first, a transient failure would lose it: no retry, the reaper could
        // never see it, and the browser would bill on with nothing tracking it.
        let resolvableDuringRelease: boolean | undefined;
        const registry: InMemoryHandleRegistry = new InMemoryHandleRegistry({
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
            expiresAt: Date.now() + 60_000,
        });

        await registry.release(handle, ORG_A, 'explicit');
        expect(resolvableDuringRelease, 'the record was deleted before the release was awaited').toBe(true);
    });

    it('keeps the handle when the Steel release fails, so the reaper can retry', async () => {
        let attempts = 0;
        const registry = new InMemoryHandleRegistry({
            releaseSteelSession: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('steel unreachable');
            },
        });
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: Date.now() + 60_000,
        });

        await expect(registry.release(handle, ORG_A, 'explicit')).rejects.toThrow(/steel unreachable/);
        expect(await registry.countLive(ORG_A), 'the handle was dropped despite the failure').toBe(1);
        expect(registry.releaseCounts().explicit, 'the leak metric counted a release that never happened').toBe(0);

        await expect(registry.release(handle, ORG_A, 'explicit')).resolves.toBeTruthy();
        expect(await registry.countLive(ORG_A)).toBe(0);
        expect(registry.releaseCounts().explicit).toBe(1);
    });

    it('fences new agent and human ownership before the external release begins', async () => {
        let finish!: () => void;
        let started!: () => void;
        const releasing = new Promise<void>(resolve => (started = resolve));
        const gate = new Promise<void>(resolve => (finish = resolve));
        const registry = new InMemoryHandleRegistry({
            releaseSteelSession: async () => {
                started();
                await gate;
            },
        });
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: Date.now() + 60_000,
        });

        const pending = registry.release(handle, ORG_A, 'explicit');
        await releasing;
        await expect(registry.resolveForAgent(handle, ORG_A)).rejects.toMatchObject({ code: 'session_releasing' });
        await expect(registry.acquireHumanControl(handle, ORG_A, 60_000)).rejects.toMatchObject({
            code: 'session_releasing',
        });
        finish();
        await pending;
    });

    it('counts the release only once even if the same handle is released twice', async () => {
        const { registry } = newRegistry();
        const { handle } = await registry.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: Date.now() + 60_000,
        });
        await registry.release(handle, ORG_A, 'explicit');
        await registry.release(handle, ORG_A, 'explicit');
        expect(registry.releaseCounts().explicit).toBe(1);
    });
});

describe('InMemoryHandleRegistry.reap', () => {
    it('releases handles idle past the deadline and leaves fresh ones alone', async () => {
        vi.useFakeTimers();
        try {
            const { registry, released } = newRegistry();
            const stale = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-stale',
                expiresAt: Date.now() + 600_000,
            });
            vi.advanceTimersByTime(200_000);
            const fresh = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-fresh',
                expiresAt: Date.now() + 600_000,
            });

            const reaped = await registry.reap({ idleMs: 120_000 });

            expect(reaped).toBe(1);
            expect(released).toEqual(['steel-stale']);
            await expect(registry.resolve(stale.handle, ORG_A)).rejects.toBeInstanceOf(SteelToolError);
            await expect(registry.resolve(fresh.handle, ORG_A)).resolves.toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('releases handles past their hard expiry regardless of recent use', async () => {
        vi.useFakeTimers();
        try {
            const { registry, released } = newRegistry();
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 1_000,
            });
            vi.advanceTimersByTime(2_000);
            await registry.touch(handle);
            expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
            expect(released).toEqual(['steel-1']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves a handle awaiting human input alone, because our idle clock cannot see the human', async () => {
        // Steel's own inactivityTimeout counts remote input in the live session, so a person typing
        // in the viewer keeps the browser alive. Our reaper only sees tool calls, so during a
        // pending elicitation it is the less informed of the two clocks and must defer.
        vi.useFakeTimers();
        try {
            const { registry, released } = newRegistry();
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 600_000,
            });
            await registry.awaitInput(handle, Date.now() + 300_000);
            vi.advanceTimersByTime(200_000);

            expect(await registry.reap({ idleMs: 120_000 })).toBe(0);
            expect(released).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('still reaps a handle awaiting human input once its hard expiry passes', async () => {
        // The grace window suspends our slot reclamation only. The hard timeout is Steel's, and
        // nothing about a pending elicitation may extend it.
        vi.useFakeTimers();
        try {
            const { registry, released } = newRegistry();
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 1_000,
            });
            await registry.awaitInput(handle, Date.now() + 600_000);
            vi.advanceTimersByTime(2_000);

            expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
            expect(released).toEqual(['steel-1']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reaps a handle again once its grace window lapses, so a walked-away human frees the slot', async () => {
        vi.useFakeTimers();
        try {
            const { registry, released } = newRegistry();
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 900_000,
            });
            await registry.awaitInput(handle, Date.now() + 60_000);
            vi.advanceTimersByTime(120_000);

            expect(await registry.reap({ idleMs: 90_000 })).toBe(1);
            expect(released).toEqual(['steel-1']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears the grace window on the next real call, so normal idle accounting resumes', async () => {
        vi.useFakeTimers();
        try {
            const { registry, released } = newRegistry();
            const { handle } = await registry.create({
                principal: ORG_A,
                steelSessionId: 'steel-1',
                expiresAt: Date.now() + 900_000,
            });
            await registry.awaitInput(handle, Date.now() + 600_000);
            await registry.touch(handle);
            vi.advanceTimersByTime(200_000);

            expect(await registry.reap({ idleMs: 120_000 })).toBe(1);
            expect(released).toEqual(['steel-1']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('counts releases by path so the Steel backstop can be alerted on', async () => {
        const { registry } = newRegistry();
        const a = await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: Date.now() + 60_000 });
        const b = await registry.create({ principal: ORG_A, steelSessionId: 's2', expiresAt: Date.now() + 60_000 });
        await registry.release(a.handle, ORG_A, 'explicit');
        await registry.release(b.handle, ORG_A, 'stream_close');
        expect(registry.releaseCounts()).toMatchObject({ explicit: 1, stream_close: 1, idle: 0, hard_expiry: 0 });
    });

    it('attributes idle and hard expiry separately, with hard expiry winning', async () => {
        vi.useFakeTimers();
        try {
            const registry = new InMemoryHandleRegistry({ releaseSteelSession: async () => {} });
            await registry.create({ principal: ORG_A, steelSessionId: 'idle', expiresAt: Date.now() + 900_000 });
            await registry.create({ principal: ORG_A, steelSessionId: 'hard', expiresAt: Date.now() + 100_000 });
            vi.advanceTimersByTime(200_000);

            expect(await registry.reap({ idleMs: 120_000 })).toBe(2);
            expect(registry.releaseCounts()).toMatchObject({ idle: 1, hard_expiry: 1 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a successful release successful when its notification throws', async () => {
        const registry = new InMemoryHandleRegistry({
            releaseSteelSession: async () => {},
            onReleased: () => {
                throw new Error('telemetry unavailable');
            },
        });
        const record = await registry.create({
            principal: ORG_A,
            steelSessionId: 's1',
            expiresAt: Date.now() + 60_000,
        });

        await expect(registry.release(record.handle, ORG_A, 'explicit')).resolves.toBeTruthy();
        expect(registry.releaseCounts().explicit).toBe(1);
        expect(await registry.countLive(ORG_A)).toBe(0);
    });

    it('keeps releasing after one release fails, and reports the failure', async () => {
        const failures: unknown[] = [];
        const registry = new InMemoryHandleRegistry({
            releaseSteelSession: async (id: string) => {
                if (id === 's1') throw new Error('steel unreachable');
            },
            onReapError: error => failures.push(error),
        });
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: Date.now() - 1 });
        await registry.create({ principal: ORG_A, steelSessionId: 's2', expiresAt: Date.now() - 1 });
        expect(await registry.reap({ idleMs: 1 })).toBe(1);
        expect(failures).toHaveLength(1);
        expect((failures[0] as Error).message).toContain('steel unreachable');
    });

    it('retries a handle whose release failed on the previous sweep', async () => {
        let attempts = 0;
        const registry = new InMemoryHandleRegistry({
            releaseSteelSession: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('steel unreachable');
            },
            onReapError: () => {},
        });
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: Date.now() - 1 });

        expect(await registry.reap({ idleMs: 1 })).toBe(0);
        expect(await registry.countLive(ORG_A), 'a failed reap dropped the handle it could not release').toBe(1);

        expect(await registry.reap({ idleMs: 1 })).toBe(1);
        expect(await registry.countLive(ORG_A)).toBe(0);
        expect(registry.releaseCounts().hard_expiry).toBe(1);
    });
});

describe('InMemoryHandleRegistry.countLive', () => {
    it('counts per principal, not globally', async () => {
        const { registry } = newRegistry();
        await registry.create({ principal: ORG_A, steelSessionId: 's1', expiresAt: Date.now() + 60_000 });
        await registry.create({ principal: ORG_B, steelSessionId: 's2', expiresAt: Date.now() + 60_000 });
        expect(await registry.countLive(ORG_A)).toBe(1);
        expect(await registry.countLive(ORG_B)).toBe(1);
    });
});

describe('exhaustive shutdown', () => {
    it('releases human-controlled sessions on shutdown, then releases the remaining sessions', async () => {
        const { registry, released } = newRegistry();
        const first = await registry.create({
            principal: ORG_A,
            steelSessionId: 'first',
            expiresAt: Date.now() + 60000,
        });
        await registry.create({ principal: ORG_A, steelSessionId: 'second', expiresAt: Date.now() + 60000 });
        await registry.acquireHumanControl(first.handle, ORG_A, 30000);
        await expect(registry.release(first.handle, ORG_A, 'explicit')).rejects.toMatchObject({
            code: 'human_control_active',
        });
        expect(await registry.releaseAll('stream_close')).toBe(2);
        expect(released).toEqual(['first', 'second']);
    });
    it('attempts every release before reporting aggregated shutdown failures', async () => {
        const attempted: string[] = [];
        const registry = new InMemoryHandleRegistry({
            releaseSteelSession: async id => {
                attempted.push(id);
                if (id === 'first') throw new Error('unavailable');
            },
        });
        await registry.create({ principal: ORG_A, steelSessionId: 'first', expiresAt: Date.now() + 60000 });
        await registry.create({ principal: ORG_A, steelSessionId: 'second', expiresAt: Date.now() + 60000 });
        await expect(registry.releaseAll('stream_close')).rejects.toBeInstanceOf(AggregateError);
        expect(attempted).toEqual(['first', 'second']);
        expect(await registry.countLive(ORG_A)).toBe(1);
    });
});
