// ABOUTME: Unit tests for profile selection: which tools each named preset exposes, and that every
// ABOUTME: preset a caller can select differs from the others.
import { describe, expect, it } from 'vitest';
import { PROFILE_NAMES } from '../../src/core/config.js';
import { TOOL_TABLE, toolsForProfile } from '../../src/core/profiles.js';

describe('toolsForProfile', () => {
    it('gives scrape only the three stateless tools, which start no billed session', () => {
        expect(toolsForProfile('scrape').map(tool => tool.name)).toEqual([
            'browser_scrape',
            'browser_screenshot',
            'browser_pdf',
        ]);
    });

    it('gives browse the full default surface', () => {
        expect(toolsForProfile('browse')).toHaveLength(16);
        expect(toolsForProfile('browse').map(tool => tool.name)).toContain('browser_session_handoff');
        expect(toolsForProfile('browse').map(tool => tool.name)).toContain('browser_session_replay');
        expect(toolsForProfile('browse').at(-2)?.name).toBe('browser_session_options');
        expect(toolsForProfile('browse').at(-1)?.name).toBe('browser_session_live_view');
    });

    it('resolves every declared profile name', () => {
        for (const profile of PROFILE_NAMES) {
            expect(toolsForProfile(profile).length, `${profile} resolves to no tools`).toBeGreaterThan(0);
        }
    });

    it('offers no preset that is an alias of another', () => {
        // A caller who selects a name gets what that name promises, or the name is not offered.
        // `vision` and `full` are designed in PLAN §7 and not built, so they are not selectable:
        // accepting them would have handed a caller the browse surface under another name.
        const surfaces = PROFILE_NAMES.map(profile =>
            toolsForProfile(profile)
                .map(tool => tool.name)
                .join(',')
        );
        expect(new Set(surfaces).size, `two of ${PROFILE_NAMES.join(', ')} expose the same tools`).toBe(
            PROFILE_NAMES.length
        );
    });

    it('keeps a larger preset a superset of a smaller one, so opting up never removes a tool', () => {
        const scrape = toolsForProfile('scrape').map(tool => tool.name);
        const browse = new Set(toolsForProfile('browse').map(tool => tool.name));
        for (const name of scrape) expect(browse.has(name), `browse dropped ${name}`).toBe(true);
    });

    it('preserves table order, which is what makes a host prompt cache hit', () => {
        const table = TOOL_TABLE.map(tool => tool.name);
        const browse = toolsForProfile('browse').map(tool => tool.name);
        expect(browse).toEqual(table.filter(name => browse.includes(name)));
    });

    it('registers no tool name twice', () => {
        const names = TOOL_TABLE.map(tool => tool.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('keeps every tool name within the 64-character review limit', () => {
        for (const tool of TOOL_TABLE) expect(tool.name.length).toBeLessThanOrEqual(64);
    });
});
