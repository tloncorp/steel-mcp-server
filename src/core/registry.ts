// ABOUTME: The handle registry: mints opaque session handles, re-authorises them against the
// ABOUTME: caller's own principal on every call, releases idempotently and reaps orphans.
import { createHash, randomBytes } from 'node:crypto';
import type { MitigationState } from './errors.js';
import { SteelToolError } from './errors.js';

/** Why this registry successfully finalized a browser session. */
export type ReleasePath = 'explicit' | 'stream_close' | 'idle' | 'hard_expiry';

/** Exclusive, short-lived authority for a person to drive the remote browser. */
export interface HumanControlLease {
    /** Opaque fencing token. Only the viewer that acquired it may renew or release it. */
    token: string;
    /** Lease deadline. It never extends the session's immutable hard expiry. */
    leaseUntil: number;
}

export interface HandleRecord {
    /** Opaque, CSPRNG-derived, never a capability on its own. */
    handle: string;
    /** The Steel session this handle points at. */
    steelSessionId: string;
    /** The principal allowed to use this handle. Re-checked on every call. */
    principal: string;
    createdAt: number;
    lastUsedAt: number;
    /** Hard deadline; past this the handle is refused even if Steel has not reclaimed it yet. */
    expiresAt: number;
    viewerUrl?: string | undefined;
    /** The create request proved this client rendered the session's inline viewer. */
    inlineViewer?: boolean | undefined;
    /**
     * The self-contained live player for this session — the URL a person is handed to finish a
     * step by hand. Unauthenticated, and whoever holds it can drive the browser.
     */
    debugUrl?: string | undefined;
    /**
     * Until this instant, an elicitation is outstanding and the idle sweep leaves the handle alone.
     *
     * Steel's `inactivityTimeout` counts remote input in the live session, so a person working in
     * the player keeps the browser alive; our idle clock only sees tool calls, and a human takes
     * longer than any idle budget worth setting. During a handoff ours is the less informed clock,
     * so it defers. The hard expiry below is untouched, and so are both Steel timeouts, which
     * remain the actual guarantee — this only suspends our slot-reclamation optimisation, and only
     * for a bounded window, so a person who walks away still frees the slot.
     */
    awaitingInputUntil?: number | undefined;
    /** Present only while an authenticated viewer owns exclusive browser control. */
    humanControl?: HumanControlLease | undefined;
    /** Release fencing: once true, no new agent or viewer ownership may begin. */
    releasing?: boolean | undefined;
    /**
     * How many human-in-the-loop handoffs this handle has already been offered.
     *
     * Lives here rather than in the process because the bound has to hold for a client that never
     * echoes the signed state back: a retry may be served by any replica, and one that had never
     * seen the handle would otherwise start counting from zero and interrupt a person again.
     */
    handoffRounds: number;
    /** Session capabilities already in play, so bot-detection errors name the right next rung. */
    mitigation: MitigationState;
}

export interface CreateHandleInput {
    principal: string;
    steelSessionId: string;
    expiresAt: number;
    viewerUrl?: string | undefined;
    inlineViewer?: boolean | undefined;
    debugUrl?: string | undefined;
    mitigation?: MitigationState | undefined;
}

export interface ReapOptions {
    /** Release a handle that has not been used for this long. */
    idleMs: number;
}

/** The storage-shaped contract; the in-memory backend is the stdio and self-host implementation. */
export interface HandleRegistry {
    readonly shutdownScope: 'process_owned' | 'shared';
    readonly registryBackend: 'memory' | 'redis';
    create(input: CreateHandleInput): Promise<HandleRecord>;
    resolve(handle: string, principal: string): Promise<HandleRecord>;
    touch(handle: string): Promise<void>;
    /** Resolve a handle for a model page operation, refusing it while a person owns control. */
    resolveForAgent(handle: string, principal: string): Promise<HandleRecord>;
    acquireHumanControl(handle: string, principal: string, leaseMs: number): Promise<HumanControlLease>;
    renewHumanControl(handle: string, principal: string, token: string, leaseMs: number): Promise<HumanControlLease>;
    releaseHumanControl(handle: string, principal: string, token: string): Promise<void>;
    /** Suspends idle reclamation until `untilMs` while a person finishes a step in the live session. */
    awaitInput(handle: string, untilMs: number): Promise<void>;
    /**
     * Counts one handoff against the handle and returns the round it is.
     *
     * Atomic, so two replicas offering a handoff at the same moment cannot be handed the same round
     * number and talk one extra person into the browser between them.
     */
    recordHandoff(handle: string): Promise<number>;
    reserveProfileWriter(
        principal: string,
        profileId: string,
        ownerSteelSessionId: string,
        untilMs: number
    ): Promise<boolean>;
    releaseProfileWriter(principal: string, profileId: string, ownerSteelSessionId: string): Promise<void>;
    release(handle: string, principal: string, path: ReleasePath): Promise<HandleRecord | null>;
    list(principal: string): Promise<HandleRecord[]>;
    countLive(principal: string): Promise<number>;
    reap(options: ReapOptions): Promise<number>;
    /** Releases every process-owned record during transport/runtime shutdown. Shared stores no-op. */
    releaseAll(path: 'stream_close'): Promise<number>;
    releaseCounts(): Record<ReleasePath, number>;
}

export interface RegistryDeps {
    /**
     * Called exactly once per handle, on whichever release path fires first.
     *
     * The record's principal comes along because releasing a Steel session needs that principal's
     * credential, and a replica that did not create the session has no other way to find it.
     */
    releaseSteelSession(steelSessionId: string, principal: string): Promise<void>;
    /** Reaper failures are reported here rather than thrown, so one bad session cannot stall a sweep. */
    onReapError?: ((error: unknown) => void) | undefined;
    /** Best-effort, low-cardinality notification after irreversible successful finalization. */
    onReleased?: ((cause: ReleasePath) => void) | undefined;
}

/**
 * Derives a stable principal id from a credential.
 *
 * The credential itself never enters a handle, a log line or an error message; only this
 * one-way digest does, so a leaked registry dump does not leak API keys.
 */
export function principalFromCredential(credential: string): string {
    return createHash('sha256').update(credential).digest('hex').slice(0, 32);
}

/** The message used for both an unknown handle and a handle belonging to someone else. */
const NOT_FOUND_MESSAGE =
    'No live browser session for that session_id. It may have been released, may have expired, ' +
    'or may belong to a different credential. Call browser_session_create to start a new one.';

/**
 * The one error for an unknown handle and for someone else's handle.
 *
 * Every backend raises exactly this, so the error cannot be used to probe for the existence of
 * other people's sessions.
 */
export function handleNotFoundError(): SteelToolError {
    return new SteelToolError(NOT_FOUND_MESSAGE, { code: 'not_found' });
}

/** The distinct error for a handle that is ours but has passed its hard deadline. */
export function handleExpiredError(handle: string): SteelToolError {
    return new SteelToolError(
        'That browser session reached its hard timeout and has been released by Steel. ' +
            'Call browser_session_create to start a new one.',
        { code: 'session_expired', details: { handle } }
    );
}

/** Mints an opaque handle. Shared by every backend so entropy and prefix never diverge. */
export function mintHandle(): string {
    return `sess_${randomBytes(16).toString('base64url')}`;
}

export function mintControlToken(): string {
    return `ctl_${randomBytes(16).toString('base64url')}`;
}

export function humanControlError(leaseUntil?: number): SteelToolError {
    return new SteelToolError(
        'A person currently has exclusive control of this browser. Wait for them to choose Hand back, then take a fresh snapshot before continuing.',
        {
            code: 'human_control_active',
            details: leaseUntil === undefined ? undefined : { control_expires_at: new Date(leaseUntil).toISOString() },
        }
    );
}

export function sessionReleasingError(): SteelToolError {
    return new SteelToolError('This browser session is already being released; no new action or takeover can start.', {
        code: 'session_releasing',
    });
}

/** In-memory handle registry. One process, one replica; the hosted deployment swaps the backend. */
export class InMemoryHandleRegistry implements HandleRegistry {
    readonly shutdownScope = 'process_owned' as const;
    readonly registryBackend = 'memory' as const;
    private readonly records = new Map<string, HandleRecord>();
    private readonly profileWriters = new Map<string, { owner: string; until: number }>();
    private readonly counts: Record<ReleasePath, number> = { explicit: 0, stream_close: 0, idle: 0, hard_expiry: 0 };

    constructor(private readonly deps: RegistryDeps) {}

    private finalized(cause: ReleasePath): void {
        this.counts[cause] += 1;
        try {
            this.deps.onReleased?.(cause);
        } catch {
            // Observability is best-effort after an irreversible successful release.
        }
    }

    async create(input: CreateHandleInput): Promise<HandleRecord> {
        const now = Date.now();
        const record: HandleRecord = {
            handle: mintHandle(),
            steelSessionId: input.steelSessionId,
            principal: input.principal,
            createdAt: now,
            lastUsedAt: now,
            expiresAt: input.expiresAt,
            viewerUrl: input.viewerUrl,
            inlineViewer: input.inlineViewer,
            debugUrl: input.debugUrl,
            handoffRounds: 0,
            mitigation: input.mitigation ?? {},
        };
        this.records.set(record.handle, record);
        return record;
    }

    async resolve(handle: string, principal: string): Promise<HandleRecord> {
        const record = this.records.get(handle);
        // A handle belonging to another principal is answered exactly like an unknown handle,
        // so the error cannot be used to probe for the existence of other people's sessions.
        if (!record || record.principal !== principal) {
            throw handleNotFoundError();
        }
        if (record.expiresAt <= Date.now()) {
            throw handleExpiredError(handle);
        }
        return record;
    }

    async touch(handle: string): Promise<void> {
        const record = this.records.get(handle);
        if (!record) return;
        record.lastUsedAt = Date.now();
        // A real call arrived, so whatever a person was asked to do is over as far as the idle
        // clock is concerned; normal accounting resumes even if the handoff is re-issued below.
        record.awaitingInputUntil = undefined;
    }

    async resolveForAgent(handle: string, principal: string): Promise<HandleRecord> {
        const record = await this.resolve(handle, principal);
        if (record.humanControl && record.humanControl.leaseUntil <= Date.now()) record.humanControl = undefined;
        if (record.releasing) throw sessionReleasingError();
        if (record.humanControl) throw humanControlError(record.humanControl.leaseUntil);
        return record;
    }

    async acquireHumanControl(handle: string, principal: string, leaseMs: number): Promise<HumanControlLease> {
        const record = await this.resolve(handle, principal);
        const now = Date.now();
        if (record.releasing) throw sessionReleasingError();
        if (record.humanControl && record.humanControl.leaseUntil > now) {
            throw humanControlError(record.humanControl.leaseUntil);
        }
        const lease = { token: mintControlToken(), leaseUntil: Math.min(now + leaseMs, record.expiresAt) };
        record.humanControl = lease;
        return lease;
    }

    async renewHumanControl(
        handle: string,
        principal: string,
        token: string,
        leaseMs: number
    ): Promise<HumanControlLease> {
        const record = await this.resolve(handle, principal);
        const now = Date.now();
        if (!record.humanControl || record.humanControl.token !== token || record.humanControl.leaseUntil <= now) {
            throw humanControlError(record.humanControl?.leaseUntil);
        }
        const lease = { token, leaseUntil: Math.min(now + leaseMs, record.expiresAt) };
        record.humanControl = lease;
        return lease;
    }

    async releaseHumanControl(handle: string, principal: string, token: string): Promise<void> {
        const record = await this.resolve(handle, principal);
        if (!record.humanControl || record.humanControl.token !== token) throw humanControlError();
        record.humanControl = undefined;
        record.awaitingInputUntil = undefined;
        record.lastUsedAt = Date.now();
    }

    async awaitInput(handle: string, untilMs: number): Promise<void> {
        const record = this.records.get(handle);
        if (record) record.awaitingInputUntil = untilMs;
    }

    async recordHandoff(handle: string): Promise<number> {
        const record = this.records.get(handle);
        if (!record) return 0;
        record.handoffRounds += 1;
        return record.handoffRounds;
    }

    async reserveProfileWriter(principal: string, profileId: string, owner: string, until: number): Promise<boolean> {
        const key = `${principal}\0${profileId}`;
        const current = this.profileWriters.get(key);
        if (current && current.until > Date.now() && current.owner !== owner) return false;
        this.profileWriters.set(key, { owner, until });
        return true;
    }

    async releaseProfileWriter(principal: string, profileId: string, owner: string): Promise<void> {
        const key = `${principal}\0${profileId}`;
        if (this.profileWriters.get(key)?.owner === owner) this.profileWriters.delete(key);
    }

    /**
     * Releases the Steel session, then forgets the handle.
     *
     * The order matters: deleting the record first would lose it on a transient failure, leaving
     * nothing to retry, nothing for the reaper to find, and a browser billing on — while the
     * release counter still claimed a release that never happened.
     */
    async release(handle: string, principal: string, path: ReleasePath): Promise<HandleRecord | null> {
        const record = this.records.get(handle);
        if (!record) return null;
        if (record.principal !== principal) {
            throw handleNotFoundError();
        }
        if (record.releasing) return null;
        if (record.humanControl && record.humanControl.leaseUntil > Date.now()) {
            throw humanControlError(record.humanControl.leaseUntil);
        }
        record.releasing = true;
        try {
            await this.deps.releaseSteelSession(record.steelSessionId, record.principal);
        } catch (error) {
            record.releasing = false;
            throw error;
        }
        this.records.delete(handle);
        if (record.mitigation.persistProfile && record.mitigation.profileId) {
            await this.releaseProfileWriter(record.principal, record.mitigation.profileId, record.steelSessionId);
        }
        this.finalized(path);
        return record;
    }

    async list(principal: string): Promise<HandleRecord[]> {
        return [...this.records.values()].filter(record => record.principal === principal);
    }

    async countLive(principal: string): Promise<number> {
        return (await this.list(principal)).length;
    }

    async reap(options: ReapOptions): Promise<number> {
        const now = Date.now();
        let reaped = 0;
        for (const record of [...this.records.values()]) {
            const awaitingHuman =
                (record.awaitingInputUntil ?? 0) > now || (record.humanControl?.leaseUntil ?? 0) > now;
            const idle = !awaitingHuman && now - record.lastUsedAt >= options.idleMs;
            const expired = record.expiresAt <= now;
            if (!idle && !expired) continue;

            try {
                if (record.releasing) continue;
                record.releasing = true;
                await this.deps.releaseSteelSession(record.steelSessionId, record.principal);
                this.records.delete(record.handle);
                if (record.mitigation.persistProfile && record.mitigation.profileId) {
                    await this.releaseProfileWriter(
                        record.principal,
                        record.mitigation.profileId,
                        record.steelSessionId
                    );
                }
                this.finalized(expired ? 'hard_expiry' : 'idle');
                reaped += 1;
            } catch (error) {
                record.releasing = false;
                // The record stays so the next sweep tries again. Dropping it here would leave the
                // browser running with nothing in this process aware that it exists.
                this.deps.onReapError?.(error);
            }
        }
        return reaped;
    }

    async releaseAll(path: 'stream_close'): Promise<number> {
        let released = 0;
        for (const record of [...this.records.values()]) {
            if (await this.release(record.handle, record.principal, path)) released += 1;
        }
        return released;
    }

    releaseCounts(): Record<ReleasePath, number> {
        return { ...this.counts };
    }
}
