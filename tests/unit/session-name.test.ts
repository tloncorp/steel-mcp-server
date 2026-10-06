// ABOUTME: The session-name vocabulary stays readable, unambiguous, and large enough for reuse.
import { describe, expect, it } from 'vitest';
import { mintHandle, SESSION_ADJECTIVES, SESSION_ANIMALS, SESSION_COLORS } from '../../src/core/session-name.js';

describe('session names', () => {
    it('uses distinct lowercase words with no separators inside a word', () => {
        for (const words of [SESSION_ADJECTIVES, SESSION_COLORS, SESSION_ANIMALS]) {
            expect(new Set(words).size).toBe(words.length);
            for (const word of words) expect(word).toMatch(/^[a-z]{2,12}$/);
        }
        expect(SESSION_ADJECTIVES.length * SESSION_COLORS.length * SESSION_ANIMALS.length).toBeGreaterThanOrEqual(
            500_000
        );
    });

    it('generates exactly one adjective, color, and animal separated by hyphens', () => {
        for (let i = 0; i < 100; i++) {
            const words = mintHandle().split('-');
            expect(words).toHaveLength(3);
            expect(SESSION_ADJECTIVES).toContain(words[0]);
            expect(SESSION_COLORS).toContain(words[1]);
            expect(SESSION_ANIMALS).toContain(words[2]);
        }
    });
});
