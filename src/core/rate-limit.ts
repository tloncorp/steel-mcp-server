// ABOUTME: Per-principal, cost-weighted admission control: a token bucket whose weights protect the
// ABOUTME: caller's concurrency slots and Steel's Browser Tools cap, and the error a rejection returns.
import { SteelToolError } from './errors.js';

/**
 * The admission-control contract.
 *
 * `charge` is async so the in-memory bucket can be swapped for a shared store (one budget across
 * replicas) without touching a single call site.
 */
export interface RateLimiter {
    /**
     * Charges one call of `toolName` to `principal`.
     *
     * Resolves when the call is admitted, and throws a `rate_limited` {@link SteelToolError} that
     * names the limit and a retry-after when it is not.
     */
    charge(principal: string, toolName: string): Promise<void>;
}

/**
 * What one call of each tool costs, in budget units. This table is the tuning surface.
 *
 * It protects two scarce resources, and neither of them is money: a fully leaked 15-minute Launch
 * session costs $0.025, while a **concurrency slot** is one of ten on Launch, and every **Browser
 * Tools call** spends one of the twenty per minute the whole org shares. So the weights track
 * which of those two a call consumes:
 *
 * - `browser_session_create` claims a concurrency slot for minutes, so it is the most expensive call
 *   on the surface by a wide margin.
 * - `browser_batch` fans out to many CDP round-trips inside one request.
 * - `browser_navigate`, `browser_act` and `browser_snapshot` each keep a live session busy.
 * - `browser_find`, `browser_wait_for` and `browser_session_diagnostics` work against a session that is
 *   already open and add no new load of their own.
 * - `browser_scrape`, `browser_screenshot` and `browser_pdf` are single Browser Tools calls that start no
 *   session, so they are the cheapest thing a rate-limited agent can be steered towards.
 * - `browser_session_live_view` is one session read for the inline viewer. It touches no browser and
 *   spends no Browser Tools call, and the app re-asks for it whenever its stream reconnects, so
 *   pricing it like a navigation would let a flapping viewer eat an agent's whole budget.
 * - `browser_session_replay` reads one finished session and returns its safe dashboard link. It starts no
 *   browser and consumes no concurrency slot, so it costs the same as another stateless read.
 * - `browser_session_release` is free: charging for handing a slot back would protect nothing and
 *   would keep a browser billing while its owner waited out a budget.
 */
export const TOOL_COSTS: Readonly<Record<string, number>> = {
    browser_session_create: 10,
    browser_batch: 6,
    browser_navigate: 3,
    browser_act: 3,
    browser_snapshot: 3,
    browser_find: 2,
    browser_wait_for: 2,
    browser_session_diagnostics: 2,
    browser_scrape: 1,
    browser_screenshot: 1,
    browser_pdf: 1,
    browser_session_handoff: 1,
    browser_session_replay: 1,
    browser_session_options: 3,
    // App control heartbeats must not consume the model's browser budget.
    browser_session_live_view: 0,
    browser_session_release: 0,
};

/** Charged to a tool the table does not name, so a tool added later is never accidentally free. */
export const DEFAULT_TOOL_COST = 3;

/** The cost of one call of a tool, in budget units. */
export function toolCost(toolName: string): number {
    return TOOL_COSTS[toolName] ?? DEFAULT_TOOL_COST;
}

export interface RateLimitPolicy {
    /** Budget units restored per minute. The sustained rate a principal may keep up forever. */
    refillPerMinute: number;
    /** Bucket size: how much unspent budget a principal may save up and spend at once. */
    burstCapacity: number;
}

/**
 * The shipped budget.
 *
 * 20 units/minute is Steel's per-org Browser Tools cap expressed in units, so a caller doing
 * nothing but `browser_scrape` paces exactly at that limit instead of collecting 429s. The 40-unit
 * bucket is two minutes of budget, which absorbs an agent's opening burst while still capping
 * sustained `browser_session_create` at two per minute. Steel enforces the independent concurrency
 * ceiling, while the MCP budget prevents a caller from hammering session creation up to that edge.
 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = { refillPerMinute: 20, burstCapacity: 40 };

/** The name a rejection uses for itself, so an operator can grep it and a model can quote it. */
export const RATE_LIMIT_NAME = 'hosted request budget';

export interface RateLimitRejection {
    toolName: string;
    cost: number;
    availableUnits: number;
    policy: RateLimitPolicy;
}

/** Rounds down, so the units the error reports are never more than the units actually left. */
function reportUnits(units: number): number {
    return Math.floor(units * 10) / 10;
}

/**
 * Builds the rejection error.
 *
 * A bare failure would leave the model with nothing to do but retry blindly, so the text names
 * which limit refused the call, what the call cost, when the budget will cover it, and the two
 * cheaper moves available right now.
 */
export function rateLimitedError(rejection: RateLimitRejection): SteelToolError {
    const { toolName, cost, availableUnits, policy } = rejection;
    const retryAfterSeconds = Math.max(1, Math.ceil(((cost - availableUnits) * 60) / policy.refillPerMinute));

    return new SteelToolError(
        `Rate limited by this server's ${RATE_LIMIT_NAME}, not by Steel: ${toolName} costs ${cost} budget ` +
            `${cost === 1 ? 'unit' : 'units'} and only ${reportUnits(availableUnits)} of ${policy.burstCapacity} ` +
            `are left. The budget refills at ${policy.refillPerMinute} units/min. ` +
            `Retry after ${retryAfterSeconds}s. ` +
            'The budget protects the concurrent-session cap of this plan and the separate 20 requests/min ' +
            'Browser Tools limit, both of which every call on this credential shares. ' +
            'browser_scrape, browser_screenshot and browser_pdf are the cheapest calls and start no session; ' +
            'browser_session_release always goes through and hands a concurrency slot back.',
        {
            code: 'rate_limited',
            retryAfterSeconds,
            details: {
                limit: RATE_LIMIT_NAME,
                tool: toolName,
                cost,
                availableUnits: reportUnits(availableUnits),
                refillPerMinute: policy.refillPerMinute,
                burstCapacity: policy.burstCapacity,
            },
        }
    );
}

export interface RateLimiterOptions {
    policy?: RateLimitPolicy | undefined;
    /** Injected so refill is testable without sleeping, matching the clock in `ServerDeps`. */
    now?: (() => Date) | undefined;
}

interface Bucket {
    units: number;
    updatedAt: number;
}

/**
 * Above this many tracked principals, buckets that have refilled to capacity are dropped: a full
 * bucket and a never-seen principal make every identical decision, so forgetting one costs nothing.
 */
const MAX_TRACKED_PRINCIPALS = 4_096;

/**
 * A token bucket per principal.
 *
 * A bucket beats a sliding window here because it holds two numbers per principal instead of a
 * timestamp per call: the memory is bounded by tenants rather than by traffic, and the same two
 * numbers port to a shared store as one atomic hash. The bucket also expresses the thing being
 * protected directly — a sustained rate plus a burst allowance — which a window does not.
 */
export class InMemoryRateLimiter implements RateLimiter {
    private readonly buckets = new Map<string, Bucket>();
    private readonly policy: RateLimitPolicy;
    private readonly now: () => Date;

    constructor(options: RateLimiterOptions = {}) {
        this.policy = options.policy ?? DEFAULT_RATE_LIMIT_POLICY;
        this.now = options.now ?? (() => new Date());
    }

    async charge(principal: string, toolName: string): Promise<void> {
        const cost = toolCost(toolName);
        if (cost === 0) return;

        const nowMs = this.now().getTime();
        const bucket = this.refilled(principal, nowMs);
        if (bucket.units < cost) {
            throw rateLimitedError({ toolName, cost, availableUnits: bucket.units, policy: this.policy });
        }
        bucket.units -= cost;
    }

    private refilled(principal: string, nowMs: number): Bucket {
        const existing = this.buckets.get(principal);
        if (!existing) {
            this.prune(nowMs);
            const fresh: Bucket = { units: this.policy.burstCapacity, updatedAt: nowMs };
            this.buckets.set(principal, fresh);
            return fresh;
        }

        // Elapsed time is clamped at zero so a clock that steps backwards cannot mint budget, and
        // the multiplication comes before the division so a whole number of seconds of refill is
        // exactly the number of units it should be rather than a hair under it.
        const elapsedMs = Math.max(0, nowMs - existing.updatedAt);
        existing.units = Math.min(
            this.policy.burstCapacity,
            existing.units + (elapsedMs * this.policy.refillPerMinute) / 60_000
        );
        existing.updatedAt = nowMs;
        return existing;
    }

    private prune(nowMs: number): void {
        if (this.buckets.size < MAX_TRACKED_PRINCIPALS) return;
        const fullAfterMs = (this.policy.burstCapacity / this.policy.refillPerMinute) * 60_000;
        for (const [principal, bucket] of this.buckets) {
            if (nowMs - bucket.updatedAt >= fullAfterMs) this.buckets.delete(principal);
        }
    }
}
