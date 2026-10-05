// ABOUTME: Redis-backed handle registry: interchangeable replicas share one set of session handles,
// ABOUTME: behind a narrow command interface and with the same semantics as the in-memory backend.
import { SteelToolError } from './errors.js';
import {
    type CreateHandleInput,
    type HandleRecord,
    type HandleRegistry,
    type HumanControlLease,
    handleExpiredError,
    handleNotFoundError,
    humanControlError,
    mintControlToken,
    mintHandle,
    type ReapOptions,
    type RegistryDeps,
    type ReleasePath,
    sessionReleasingError,
} from './registry.js';

/**
 * The Redis commands this registry issues, and nothing more.
 *
 * Keeping the surface this small is what lets the whole state machine be tested against an
 * in-memory store: no server, no client library, no network in the unit suite.
 */
export interface RedisCommands {
    get(key: string): Promise<string | null>;
    /**
     * Writes a value with a millisecond time-to-live.
     *
     * The TTL is a garbage-collection net for records no replica ever sweeps, never a release
     * path: it is always set far beyond the handle's own hard expiry.
     */
    set(key: string, value: string, ttlMs: number): Promise<void>;
    /** SET NX PX: claims a missing expiring key atomically. */
    setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
    /** Replaces an expiring value only when its current bytes match `expected`. */
    compareSet(key: string, expected: string, value: string, ttlMs: number): Promise<boolean>;
    /** Deletes a value only when its current bytes match `expected`. */
    compareDelete(key: string, expected: string): Promise<boolean>;
    /** Returns how many keys were removed, which is how one of two concurrent sweepers wins. */
    del(key: string): Promise<number>;
    /**
     * Atomically adds one to the integer at `key` and returns the new value.
     *
     * A missing key counts as zero, so the first call returns 1. Redis creates that key with no
     * expiry at all and an increment never changes an existing one, so a TTL is `pexpire`'s job.
     */
    incr(key: string): Promise<number>;
    /** Puts a millisecond time-to-live on a key that exists. A missing key is left alone. */
    pexpire(key: string, ttlMs: number): Promise<void>;
    sadd(key: string, member: string): Promise<void>;
    srem(key: string, member: string): Promise<void>;
    smembers(key: string): Promise<string[]>;
}

export interface RedisRegistryDeps extends RegistryDeps {
    commands: RedisCommands;
    /** Key namespace, so one Redis can serve more than one deployment. */
    keyPrefix?: string | undefined;
    now?: (() => Date) | undefined;
}

const DEFAULT_KEY_PREFIX = 'steel-mcp';

/**
 * How long a record outlives its own hard expiry before Redis drops it.
 *
 * Long enough that a reaper sweep — including one that has to retry a failed Steel release for a
 * while — always finds the record it needs. Steel's own `inactivityTimeout` is what actually
 * guarantees the browser is gone by then; this only stops abandoned keys accumulating forever.
 */
const RECORD_GRACE_MS = 86_400_000;

/**
 * How long the activity, pending-input and handoff-round keys live.
 *
 * Its expiry is not a deadline anything depends on: a missing `lastUsedAt` means nothing has
 * touched the handle for this long, so falling back to `createdAt` reports it as idle, which it
 * demonstrably is. That holds for any session duration, so this needs no relation to one. It always
 * outlives the record for the same reason, so a live handle never loses a handoff round to it.
 */
const MUTABLE_FIELD_TTL_MS = RECORD_GRACE_MS;

/**
 * The immutable part of a record, which is the only part stored as JSON.
 *
 * `lastUsedAt`, `awaitingInputUntil` and `handoffRounds` are deliberately absent: they change after
 * creation, and a whole-record rewrite is what made a concurrent touch able to undo a release or a
 * handoff.
 */
type StoredRecord = Omit<
    HandleRecord,
    'lastUsedAt' | 'awaitingInputUntil' | 'handoffRounds' | 'humanControl' | 'releasing'
>;

/** Reads a timestamp key, treating anything unparseable as absent. */
function readTimestamp(raw: string | null): number | undefined {
    if (raw === null) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** Handle registry over a shared Redis, so any replica can serve a handle any other replica minted. */
export class RedisHandleRegistry implements HandleRegistry {
    readonly shutdownScope = 'shared' as const;
    readonly registryBackend = 'redis' as const;
    private readonly commands: RedisCommands;
    private readonly prefix: string;
    private readonly now: () => Date;
    private readonly counts: Record<ReleasePath, number> = { explicit: 0, stream_close: 0, idle: 0, hard_expiry: 0 };

    constructor(private readonly deps: RedisRegistryDeps) {
        this.commands = deps.commands;
        this.prefix = deps.keyPrefix ?? DEFAULT_KEY_PREFIX;
        this.now = deps.now ?? (() => new Date());
    }

    private finalized(cause: ReleasePath): void {
        this.counts[cause] += 1;
        try {
            this.deps.onReleased?.(cause);
        } catch {
            // Observability is best-effort after the shared record has been removed.
        }
    }

    private recordKey(handle: string): string {
        return `${this.prefix}:handle:${handle}`;
    }

    /**
     * Keys holding fields that change after creation.
     *
     * The first three are each owned by one operation. Human/release ownership shares `control`,
     * where SET-NX and compare-and-set provide the atomic fencing a plain record rewrite cannot.
     * A handle is base64url, so no suffix can collide with another handle's record key.
     */
    private usedKey(handle: string): string {
        return `${this.recordKey(handle)}:used`;
    }

    private awaitKey(handle: string): string {
        return `${this.recordKey(handle)}:await`;
    }

    private roundsKey(handle: string): string {
        return `${this.recordKey(handle)}:rounds`;
    }

    private controlKey(handle: string): string {
        return `${this.recordKey(handle)}:control`;
    }

    private profileWriterKey(principal: string, profileId: string): string {
        return `${this.prefix}:profile-writer:${principal}:${profileId}`;
    }

    /** Index of one principal's handles, so a count or a list never scans another tenant's records. */
    private principalKey(principal: string): string {
        return `${this.prefix}:principal:${principal}`;
    }

    /** Index every reaper sweeps, holding `<principal>:<handle>` members. */
    private get liveKey(): string {
        return `${this.prefix}:live`;
    }

    /** Reassembles a record from its immutable JSON and four keys holding mutable fields. */
    private async read(handle: string): Promise<HandleRecord | null> {
        // Issued together so reading five keys costs one round trip rather than five.
        const [raw, used, awaiting, rounds, control] = await Promise.all([
            this.commands.get(this.recordKey(handle)),
            this.commands.get(this.usedKey(handle)),
            this.commands.get(this.awaitKey(handle)),
            this.commands.get(this.roundsKey(handle)),
            this.commands.get(this.controlKey(handle)),
        ]);
        // The record is what decides whether the handle exists at all; the other three are only ever
        // read for a handle that does, so a stray one left by a released handle changes nothing.
        if (raw === null) return null;

        let stored: StoredRecord;
        try {
            stored = JSON.parse(raw) as StoredRecord;
        } catch {
            // A record we cannot read is a record we cannot authorise, so it is answered exactly
            // like an unknown handle. The next sweep clears the key out.
            return null;
        }

        let humanControl: HandleRecord['humanControl'];
        let releasing = false;
        if (control !== null) {
            try {
                const parsed = JSON.parse(control) as HumanControlLease | { releasing?: unknown };
                if ('releasing' in parsed && parsed.releasing === true) {
                    releasing = true;
                } else if (
                    'token' in parsed &&
                    typeof parsed.token === 'string' &&
                    Number.isFinite(parsed.leaseUntil)
                ) {
                    humanControl = parsed;
                }
            } catch {
                // A malformed lease grants nobody control and expires independently.
            }
        }

        return {
            ...stored,
            // No use recorded means none since creation — see MUTABLE_FIELD_TTL_MS for why an
            // expired key is the same answer.
            lastUsedAt: readTimestamp(used) ?? stored.createdAt,
            awaitingInputUntil: readTimestamp(awaiting),
            // No counter key means no handoff has been offered yet.
            handoffRounds: readTimestamp(rounds) ?? 0,
            humanControl,
            releasing,
        };
    }

    /**
     * Writes the immutable record. Called once per handle, by `create` and nothing else.
     *
     * That it is written exactly once is what makes a released handle unresurrectable: no later
     * operation can put the record back after a `release` has deleted it.
     */
    private async write(record: StoredRecord): Promise<void> {
        // Never below the grace period: a handle that is already long expired still needs a record
        // to release, and Redis rejects a non-positive expiry outright.
        const ttlMs = Math.max(record.expiresAt - this.now().getTime() + RECORD_GRACE_MS, RECORD_GRACE_MS);
        await this.commands.set(this.recordKey(record.handle), JSON.stringify(record), ttlMs);
    }

    /**
     * Removes a record, all four mutable-field keys and both index entries.
     *
     * Returns whether this caller was the one that removed the record. Two replicas sweeping at
     * once both see the handle, so `del` of the record deciding the winner is what keeps the
     * release counters honest without a distributed lock — which is also why it goes first.
     */
    private async forget(principal: string, handle: string): Promise<boolean> {
        const removed = await this.commands.del(this.recordKey(handle));
        await this.commands.del(this.usedKey(handle));
        await this.commands.del(this.awaitKey(handle));
        await this.commands.del(this.roundsKey(handle));
        await this.commands.del(this.controlKey(handle));
        await this.commands.srem(this.principalKey(principal), handle);
        await this.commands.srem(this.liveKey, `${principal}:${handle}`);
        return removed > 0;
    }

    async create(input: CreateHandleInput): Promise<HandleRecord> {
        const now = this.now().getTime();
        const stored: StoredRecord = {
            handle: mintHandle(),
            steelSessionId: input.steelSessionId,
            principal: input.principal,
            createdAt: now,
            expiresAt: input.expiresAt,
            viewerUrl: input.viewerUrl,
            inlineViewer: input.inlineViewer,
            // The live-player URL the human-in-the-loop handoff hands a person. Without it every
            // login wall and CAPTCHA degrades to an error no one can act on.
            debugUrl: input.debugUrl,
            mitigation: input.mitigation ?? {},
        };
        // The record is written before it is indexed, so an index entry never names a handle that
        // cannot be read back and released.
        await this.write(stored);
        await this.commands.sadd(this.principalKey(stored.principal), stored.handle);
        await this.commands.sadd(this.liveKey, `${stored.principal}:${stored.handle}`);
        // Neither mutable key is written: at creation the last use is `createdAt` and no handoff has
        // been offered, which is exactly what `read` reports for an absent key.
        return { ...stored, lastUsedAt: now, handoffRounds: 0 };
    }

    async resolve(handle: string, principal: string): Promise<HandleRecord> {
        const record = await this.read(handle);
        // A handle belonging to another principal is answered exactly like an unknown handle,
        // so the error cannot be used to probe for the existence of other people's sessions.
        if (!record || record.principal !== principal) {
            throw handleNotFoundError();
        }
        if (record.expiresAt <= this.now().getTime()) {
            throw handleExpiredError(handle);
        }
        return record;
    }

    /**
     * Records a real call against the handle.
     *
     * Deliberately reads nothing. Writing a value derived from a record read a round trip earlier
     * is what let a touch put back a record another replica had just released, and undo a handoff
     * another replica had just registered. Both writes here are single-key and unconditional, so
     * concurrent operations resolve in the order Redis runs them, exactly as they do in one process.
     *
     * The cost is that an unknown handle leaves a stray key behind rather than doing nothing. No
     * caller reaches this without a successful `resolve` first, and the key expires by itself.
     */
    async touch(handle: string): Promise<void> {
        await this.commands.set(this.usedKey(handle), String(this.now().getTime()), MUTABLE_FIELD_TTL_MS);
        // A real call arrived, so whatever a person was asked to do is over as far as the idle
        // clock is concerned; normal accounting resumes even if the handoff is re-issued after.
        await this.commands.del(this.awaitKey(handle));
    }

    async resolveForAgent(handle: string, principal: string): Promise<HandleRecord> {
        const record = await this.resolve(handle, principal);
        if (record.releasing) throw sessionReleasingError();
        if (record.humanControl && record.humanControl.leaseUntil > this.now().getTime()) {
            throw humanControlError(record.humanControl.leaseUntil);
        }
        return record;
    }

    async acquireHumanControl(handle: string, principal: string, leaseMs: number) {
        const record = await this.resolve(handle, principal);
        const now = this.now().getTime();
        if (record.releasing) throw sessionReleasingError();
        const lease = { token: mintControlToken(), leaseUntil: Math.min(now + leaseMs, record.expiresAt) };
        const raw = JSON.stringify(lease);
        const claimed = await this.commands.setIfAbsent(
            this.controlKey(handle),
            raw,
            Math.max(1, lease.leaseUntil - now)
        );
        if (!claimed) {
            const current = await this.read(handle);
            if (current?.releasing) throw sessionReleasingError();
            throw humanControlError(current?.humanControl?.leaseUntil);
        }
        return lease;
    }

    async renewHumanControl(handle: string, principal: string, token: string, leaseMs: number) {
        const record = await this.resolve(handle, principal);
        const current = record.humanControl;
        const now = this.now().getTime();
        if (!current || current.token !== token || current.leaseUntil <= now) throw humanControlError();
        const lease = { token, leaseUntil: Math.min(now + leaseMs, record.expiresAt) };
        const renewed = await this.commands.compareSet(
            this.controlKey(handle),
            JSON.stringify(current),
            JSON.stringify(lease),
            Math.max(1, lease.leaseUntil - now)
        );
        if (!renewed) throw humanControlError();
        return lease;
    }

    async releaseHumanControl(handle: string, principal: string, token: string): Promise<void> {
        const record = await this.resolve(handle, principal);
        const current = record.humanControl;
        if (!current || current.token !== token) throw humanControlError();
        if (!(await this.commands.compareDelete(this.controlKey(handle), JSON.stringify(current)))) {
            throw humanControlError();
        }
        await this.commands.del(this.awaitKey(handle));
        await this.commands.set(this.usedKey(handle), String(this.now().getTime()), MUTABLE_FIELD_TTL_MS);
    }

    async awaitInput(handle: string, untilMs: number): Promise<void> {
        await this.commands.set(this.awaitKey(handle), String(untilMs), MUTABLE_FIELD_TTL_MS);
    }

    /**
     * Counts one handoff against the handle, atomically across replicas.
     *
     * `incr` is the whole point: read-then-write would hand the same round number to two replicas
     * offering a handoff at the same moment, and one extra person would be pulled into the browser
     * between them. The expiry is a second command because Redis creates a counter key with none,
     * and it is refreshed every round rather than only the first, as the other two keys are.
     */
    async recordHandoff(handle: string): Promise<number> {
        const rounds = await this.commands.incr(this.roundsKey(handle));
        await this.commands.pexpire(this.roundsKey(handle), MUTABLE_FIELD_TTL_MS);
        return rounds;
    }

    async reserveProfileWriter(principal: string, profileId: string, owner: string, until: number): Promise<boolean> {
        return this.commands.setIfAbsent(
            this.profileWriterKey(principal, profileId),
            owner,
            Math.max(1, until - this.now().getTime())
        );
    }

    async releaseProfileWriter(principal: string, profileId: string, owner: string): Promise<void> {
        await this.commands.compareDelete(this.profileWriterKey(principal, profileId), owner);
    }

    /**
     * Releases the Steel session, then forgets the handle.
     *
     * The order matters: deleting the record first would lose it on a transient failure, leaving
     * nothing to retry, nothing for any replica's reaper to find, and a browser billing on — while
     * the release counter still claimed a release that never happened.
     */
    async release(handle: string, principal: string, path: ReleasePath): Promise<HandleRecord | null> {
        const record = await this.read(handle);
        if (!record) return null;
        if (record.principal !== principal) {
            throw handleNotFoundError();
        }
        if (record.releasing) return null;
        if (record.humanControl && record.humanControl.leaseUntil > this.now().getTime()) {
            throw humanControlError(record.humanControl.leaseUntil);
        }
        const marker = JSON.stringify({ releasing: true, token: mintControlToken() });
        if (!(await this.commands.setIfAbsent(this.controlKey(handle), marker, 120_000))) {
            const current = await this.read(handle);
            if (current?.humanControl) throw humanControlError(current.humanControl.leaseUntil);
            return null;
        }
        try {
            await this.deps.releaseSteelSession(record.steelSessionId, record.principal);
            await this.releaseLedgers(record);
            if (await this.forget(principal, handle)) this.finalized(path);
        } catch (error) {
            await this.commands.compareDelete(this.controlKey(handle), marker);
            throw error;
        }
        return record;
    }

    /** Keep the handle indexed until both ledgers are clean, so any replica can retry a failure. */
    private async releaseLedgers(record: HandleRecord): Promise<void> {
        await this.releaseSessionSlot(record.principal, record.steelSessionId);
        if (record.mitigation.persistProfile && record.mitigation.profileId) {
            await this.releaseProfileWriter(record.principal, record.mitigation.profileId, record.steelSessionId);
        }
    }

    async list(principal: string): Promise<HandleRecord[]> {
        const handles = await this.commands.smembers(this.principalKey(principal));
        const records: HandleRecord[] = [];
        for (const handle of handles) {
            const record = await this.read(handle);
            if (record?.principal === principal) records.push(record);
            // An index entry with no readable record is stale: another replica released it, or the
            // key aged out. Dropping it here keeps the index from growing without bound.
            else await this.forget(principal, handle);
        }
        return records;
    }

    async countLive(principal: string): Promise<number> {
        return (await this.list(principal)).length;
    }

    /** CAS keeps pending creations and live sessions in one expiring per-principal capacity ledger. */
    private async updateSessionSlots(
        principal: string,
        update: (slots: Map<string, number>) => boolean
    ): Promise<boolean> {
        const key = `${this.prefix}:capacity:${principal}`;
        for (let attempt = 0; attempt < 32; attempt++) {
            const raw = await this.commands.get(key);
            const now = this.now().getTime();
            const slots = new Map<string, number>(raw === null ? [] : JSON.parse(raw));
            for (const [id, until] of slots) if (until <= now) slots.delete(id);
            if (!update(slots)) return false;
            if (slots.size === 0) {
                if (raw === null || (await this.commands.compareDelete(key, raw))) return true;
                continue;
            }
            const value = JSON.stringify([...slots]);
            const ttl = Math.max(1, ...[...slots.values()].map(until => until - now));
            const changed =
                raw === null
                    ? await this.commands.setIfAbsent(key, value, ttl)
                    : await this.commands.compareSet(key, raw, value, ttl);
            if (changed) return true;
        }
        throw new SteelToolError('Session capacity is busy. Retry this request.', { code: 'rate_limited' });
    }

    async reserveSessionSlot(principal: string, owner: string, expiresAt: number, limit: number): Promise<boolean> {
        // Include records created before capacity reservations were introduced. A stale release read
        // can conservatively hold a slot until hard expiry, but can never admit an extra browser.
        const live = await this.list(principal);
        return this.updateSessionSlots(principal, slots => {
            const now = this.now().getTime();
            for (const record of live) if (record.expiresAt > now) slots.set(record.steelSessionId, record.expiresAt);
            if (expiresAt <= now || (!slots.has(owner) && slots.size >= limit)) return false;
            slots.set(owner, expiresAt);
            return true;
        });
    }

    async releaseSessionSlot(principal: string, owner: string): Promise<void> {
        await this.updateSessionSlots(principal, slots => {
            slots.delete(owner);
            return true;
        });
    }

    /**
     * Sweeps every principal's handles, releasing the idle and the expired.
     *
     * A short-lived control marker fences concurrent releases. Steel release and ledger cleanup
     * are idempotent so failures can be retried; only removal of the record counts a release.
     */
    async reap(options: ReapOptions): Promise<number> {
        const now = this.now().getTime();
        let reaped = 0;
        for (const member of await this.commands.smembers(this.liveKey)) {
            const separator = member.indexOf(':');
            if (separator < 0) {
                // Not a member this registry wrote. Dropping it keeps a foreign key in the same
                // namespace out of every future sweep.
                await this.commands.srem(this.liveKey, member);
                continue;
            }
            const principal = member.slice(0, separator);
            const handle = member.slice(separator + 1);

            const record = await this.read(handle);
            if (!record) {
                await this.forget(principal, handle);
                continue;
            }

            const awaitingHuman =
                (record.awaitingInputUntil ?? 0) > now || (record.humanControl?.leaseUntil ?? 0) > now;
            const idle = !awaitingHuman && now - record.lastUsedAt >= options.idleMs;
            const expired = record.expiresAt <= now;
            if (!idle && !expired) continue;

            const marker = JSON.stringify({ releasing: true, token: mintControlToken() });
            try {
                if (!(await this.commands.setIfAbsent(this.controlKey(handle), marker, 120_000))) continue;
                await this.deps.releaseSteelSession(record.steelSessionId, record.principal);
                await this.releaseLedgers(record);
                if (await this.forget(record.principal, handle)) {
                    this.finalized(expired ? 'hard_expiry' : 'idle');
                    reaped += 1;
                }
            } catch (error) {
                await this.commands.compareDelete(this.controlKey(handle), marker);
                // The record stays so the next sweep — on this replica or any other — tries again.
                // Dropping it here would leave the browser running with nothing tracking it.
                this.deps.onReapError?.(error);
            }
        }
        return reaped;
    }

    async releaseAll(_path: 'stream_close'): Promise<number> {
        // One hosted replica does not own deployment-wide records in the shared store.
        return 0;
    }

    /** This replica's own counts. The leak metric is their sum across the fleet. */
    releaseCounts(): Record<ReleasePath, number> {
        return { ...this.counts };
    }
}
