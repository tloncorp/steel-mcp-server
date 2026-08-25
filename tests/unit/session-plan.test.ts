// ABOUTME: Pins deterministic session recipes and the principal-bound, expiring signed plan token.
// ABOUTME: The tests ensure planner state cannot cross callers or be confused with handoff state.
import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createHandoffCodec } from '../../src/core/mrtr.js';
import { createSessionPlanCodec, recommendSession } from '../../src/core/session-plan.js';

const context = {} as ServerContext;
const secret = '0123456789abcdef0123456789abcdef';

describe('session plan state', () => {
    it('round-trips only for the same principal and codec domain', async () => {
        const codec = createSessionPlanCodec(secret, 'principal-a');
        const state = {
            v: 1 as const,
            origin: 'https://example.com',
            goal: 'account' as const,
            settings: { persistProfile: true as const },
            accountContext: true,
        };
        const token = await codec.mint(state, context);
        await expect(codec.verify(token, context)).resolves.toEqual(state);
        await expect(createSessionPlanCodec(secret, 'principal-b').verify(token, context)).rejects.toThrow('bind');
        await expect(createHandoffCodec(secret).verify(token, context)).rejects.toThrow();
        expect(token).not.toContain('principal-a');
        expect(token).not.toContain(secret);
    });

    it('uses scrape for a plain read and only adds requested settings', () => {
        expect(
            recommendSession({ origin: 'https://example.com', goal: 'read', needs: [], configuredTimeoutMs: 900_000 })
                .recommendedTool
        ).toBe('browser_scrape');
        const planned = recommendSession({
            origin: 'https://example.com',
            goal: 'account',
            needs: ['mobile', 'location', 'persist_profile'],
            country: 'DE',
            configuredTimeoutMs: 900_000,
        });
        expect(planned.state?.settings).toEqual({
            deviceConfig: { device: 'mobile' },
            useProxy: { geolocation: { country: 'DE' } },
            persistProfile: true,
        });
    });

    it('does not emit a redundant timeout covered by the configured default', () => {
        const short = recommendSession({
            origin: 'https://example.com',
            goal: 'interact',
            needs: ['long_running'],
            minutes: 10,
            configuredTimeoutMs: 900_000,
            accountMaxMs: 3_600_000,
        });
        expect(short.state?.settings.timeout).toBeUndefined();
        const long = recommendSession({
            origin: 'https://example.com',
            goal: 'interact',
            needs: ['long_running'],
            minutes: 30,
            configuredTimeoutMs: 900_000,
            accountMaxMs: 1_200_000,
        });
        expect(long.state?.settings.timeout).toBe(1_200_000);
        expect(long.rationale.join(' ')).toMatch(/clamped/i);
    });
});
