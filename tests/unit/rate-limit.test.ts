// ABOUTME: Unit tests for the cost-weighted rate limiter: the weight table, per-principal isolation,
// ABOUTME: refill on the injected clock, and the rejection error naming the limit and a retry-after.
import { describe, expect, it } from 'vitest';
import { SteelToolError, toolErrorResult } from '../../src/core/errors.js';
import {
    DEFAULT_RATE_LIMIT_POLICY,
    DEFAULT_TOOL_COST,
    InMemoryRateLimiter,
    RATE_LIMIT_NAME,
    type RateLimitPolicy,
    TOOL_COSTS,
    toolCost,
} from '../../src/core/rate-limit.js';

/** One unit per second, ten units of burst: every refill in these tests lands on an exact integer. */
const TEST_POLICY: RateLimitPolicy = { refillPerMinute: 60, burstCapacity: 10 };

function clock(startMs = 1_800_000_000_000) {
    let ms = startMs;
    return {
        now: () => new Date(ms),
        advanceSeconds: (seconds: number) => {
            ms += seconds * 1_000;
        },
    };
}

function limiter(policy: RateLimitPolicy = TEST_POLICY) {
    const time = clock();
    return { limiter: new InMemoryRateLimiter({ policy, now: time.now }), time };
}

async function rejection(work: () => Promise<unknown>): Promise<SteelToolError> {
    try {
        await work();
    } catch (error) {
        if (error instanceof SteelToolError) return error;
        throw error;
    }
    throw new Error('Expected the limiter to reject this call.');
}

describe('the tool weight table', () => {
    it('charges session-creating and CDP-driving tools more than the stateless reads', () => {
        const stateless = Math.max(toolCost('browser_scrape'), toolCost('browser_screenshot'), toolCost('browser_pdf'));
        for (const tool of ['browser_session_create', 'browser_navigate', 'browser_act', 'browser_snapshot', 'browser_batch']) {
            expect(toolCost(tool), `${tool} must cost more than a stateless read`).toBeGreaterThan(stateless);
        }
        expect(toolCost('browser_session_create')).toBe(Math.max(...Object.values(TOOL_COSTS)));
    });

    it('never charges for handing a concurrency slot back', () => {
        expect(toolCost('browser_session_release')).toBe(0);
    });

    it('does not charge app control heartbeats against the model budget', () => {
        expect(toolCost('browser_session_live_view')).toBe(0);
        expect(toolCost('browser_session_live_view')).toBeLessThan(toolCost('browser_navigate'));
    });

    it('charges a handoff like a stateless coordination call', () => {
        expect(toolCost('browser_session_handoff')).toBe(toolCost('browser_scrape'));
    });

    it('charges finished replay like a stateless read, since it starts no browser', () => {
        expect(toolCost('browser_session_replay')).toBe(toolCost('browser_scrape'));
        expect(toolCost('browser_session_replay')).toBeLessThan(toolCost('browser_navigate'));
    });

    it('charges an unlisted tool the session-driving default rather than nothing', () => {
        expect(toolCost('steel_tool_added_later')).toBe(DEFAULT_TOOL_COST);
        expect(DEFAULT_TOOL_COST).toBeGreaterThan(0);
    });

    it('sizes the shipped budget so stateless reads track the 20/min Browser Tools cap', () => {
        expect(DEFAULT_RATE_LIMIT_POLICY.refillPerMinute).toBe(20);
        expect(toolCost('browser_scrape')).toBe(1);
        expect(DEFAULT_RATE_LIMIT_POLICY.burstCapacity).toBeGreaterThan(DEFAULT_RATE_LIMIT_POLICY.refillPerMinute);
    });
});

describe('cost-weighted accounting', () => {
    it('spends the bucket in proportion to the weight of each tool', async () => {
        const { limiter: rate } = limiter();

        // Ten one-unit reads exactly drain a ten-unit bucket.
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'browser_scrape');
        await expect(rate.charge('principal-a', 'browser_scrape')).rejects.toThrow(/budget/);

        // A single heavier call drains the same bucket for another principal.
        const { limiter: heavier } = limiter();
        await heavier.charge('principal-b', 'browser_batch');
        const left = TEST_POLICY.burstCapacity - toolCost('browser_batch');
        for (let call = 0; call < left; call++) await heavier.charge('principal-b', 'browser_scrape');
        await expect(heavier.charge('principal-b', 'browser_scrape')).rejects.toThrow(/budget/);
    });

    it('still admits a release once the budget is exhausted', async () => {
        const { limiter: rate } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'browser_scrape');

        await expect(rate.charge('principal-a', 'browser_session_release')).resolves.toBeUndefined();
    });
});

describe('per-principal isolation', () => {
    it('leaves every other principal untouched when one exhausts its budget', async () => {
        const { limiter: rate } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('noisy', 'browser_scrape');
        await expect(rate.charge('noisy', 'browser_scrape')).rejects.toThrow(/budget/);

        for (let call = 0; call < 10; call++) await rate.charge('quiet', 'browser_scrape');
        await expect(rate.charge('quiet', 'browser_scrape')).rejects.toThrow(/budget/);
        await expect(rate.charge('third', 'browser_session_create')).resolves.toBeUndefined();
    });
});

describe('refill on the injected clock', () => {
    it('restores budget as time passes, up to the burst ceiling', async () => {
        const { limiter: rate, time } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'browser_scrape');
        await expect(rate.charge('principal-a', 'browser_scrape')).rejects.toThrow(/budget/);

        time.advanceSeconds(3);
        for (let call = 0; call < 3; call++) await rate.charge('principal-a', 'browser_scrape');
        await expect(rate.charge('principal-a', 'browser_scrape')).rejects.toThrow(/budget/);

        // An hour of idleness cannot bank more than one bucket of budget.
        time.advanceSeconds(3_600);
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'browser_scrape');
        await expect(rate.charge('principal-a', 'browser_scrape')).rejects.toThrow(/budget/);
    });

    it('honours the retry-after it advertised', async () => {
        const { limiter: rate, time } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'browser_scrape');

        const error = await rejection(() => rate.charge('principal-a', 'browser_batch'));
        expect(error.retryAfterSeconds).toBe(toolCost('browser_batch'));

        time.advanceSeconds(error.retryAfterSeconds ?? 0);
        await expect(rate.charge('principal-a', 'browser_batch')).resolves.toBeUndefined();
    });

    it('does not hand out free budget when the clock steps backwards', async () => {
        const { limiter: rate, time } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'browser_scrape');

        time.advanceSeconds(-600);
        await expect(rate.charge('principal-a', 'browser_scrape')).rejects.toThrow(/budget/);
    });
});

describe('the rejection error', () => {
    it('names the limit, the cost, the refill rate and a concrete retry-after', async () => {
        const { limiter: rate } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'browser_scrape');

        const error = await rejection(() => rate.charge('principal-a', 'browser_navigate'));

        expect(error.code).toBe('rate_limited');
        expect(error.message).toContain(RATE_LIMIT_NAME);
        expect(error.message).toContain('browser_navigate');
        expect(error.message).toMatch(/Retry after \d+s/);
        expect(error.message).toMatch(/60 units\/min/);
        expect(error.message).toMatch(/concurrent-session cap/);
        expect(error.message).toMatch(/20 requests\/min Browser Tools/);
        expect(error.message).toMatch(/browser_scrape/);
        expect(error.details).toMatchObject({ limit: RATE_LIMIT_NAME, tool: 'browser_navigate' });
    });

    it('says it is this server rejecting the call, not Steel', async () => {
        const { limiter: rate } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'browser_scrape');

        const error = await rejection(() => rate.charge('principal-a', 'browser_scrape'));

        expect(error.message).toMatch(/not by Steel/);
    });

    it('renders as a tool-execution error carrying the retry-after', async () => {
        const { limiter: rate } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'browser_scrape');

        const error = await rejection(() => rate.charge('principal-a', 'browser_snapshot'));
        const result = toolErrorResult(error);

        expect(result.isError).toBe(true);
        expect(result.content?.map(block => ('text' in block ? block.text : '')).join('\n')).toMatch(
            new RegExp(`Retry-After: ${error.retryAfterSeconds}s`)
        );
        expect(result.structuredContent).toMatchObject({
            error: { code: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds },
        });
    });
});
