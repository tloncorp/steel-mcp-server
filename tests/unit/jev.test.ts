import { describe, expect, it } from 'vitest';
import { loadConfig, loadRegistryConfig } from '../../src/core/config.js';
import type { PageSnapshot, SnapshotNode } from '../../src/core/snapshot.js';
import { runCandidates, runEvidence } from '../../src/core/tools/run.js';

function node(overrides: Partial<SnapshotNode> = {}): SnapshotNode {
    return {
        ref: '@e1',
        role: 'textbox',
        name: 'Search',
        nameInferred: false,
        backendNodeId: 1,
        depth: 0,
        inViewport: true,
        interactive: true,
        sensitive: false,
        ...overrides,
    };
}
function snapshot(nodes: SnapshotNode[]): PageSnapshot {
    return {
        snapshotId: 's',
        loaderId: 'l',
        url: 'https://example.test/?token=private',
        title: 'Page',
        nodes,
        text: '',
        truncated: false,
    };
}

describe('Jev configuration and action space', () => {
    it('uses only operator inference credentials with the literal OpenRouter model alias', () => {
        expect(loadConfig({ STEEL_LOCAL: 'true' }).jev).toBeUndefined();
        expect(loadConfig({ STEEL_LOCAL: 'true', OPENROUTER_API_KEY: '  ' }).jev).toBeUndefined();
        expect(
            loadConfig({ STEEL_LOCAL: 'true', OPENROUTER_API_KEY: 'operator', STEEL_API_KEY: 'tenant' }).jev
        ).toEqual({ apiKey: 'operator', model: '~typesafe/jev-latest' });
        expect(
            loadConfig({ STEEL_LOCAL: 'true', OPENROUTER_API_KEY: 'operator', BROWSER_JEV_MODEL: '~typesafe/jev-1.13' })
                .jev?.model
        ).toBe('~typesafe/jev-1.13');
    });

    it('refuses distributed mode without distributed execution leases', () => {
        expect(() => loadRegistryConfig({ REDIS_URL: 'redis://localhost', OPENROUTER_API_KEY: 'operator' })).toThrow(
            /single MCP replica/
        );
    });

    it('offers supplied text only to matching non-sensitive fields and never presses Enter', () => {
        const page = snapshot([node(), node({ ref: '@e2', name: 'OTP', sensitive: true, value: 'secret-code' })]);
        const actions = [
            ...runCandidates(page, [
                { field: 'search', value: 'movie times' },
                { field: 'OTP', value: 'bad-input' },
            ]).values(),
        ];
        expect(actions.filter(candidate => candidate.action?.action === 'type')).toEqual([
            {
                label: 'Fill textbox Search with supplied input 1',
                action: { action: 'type', target: '@e1', value: 'movie times' },
            },
        ]);
        expect(actions.some(candidate => candidate.action?.action === 'press')).toBe(false);
        expect(runEvidence(page)).not.toContain('secret-code');
        expect(runEvidence(page)).not.toContain('OTP');
        expect(runEvidence(page)).not.toContain('token=');
    });

    it('never sends existing input values as page evidence', () => {
        expect(runEvidence(snapshot([node({ value: 'private-existing-input' })]))).not.toContain(
            'private-existing-input'
        );
    });

    it('preserves control state and excludes selected tabs and disabled actions', () => {
        const page = snapshot([
            node({ role: 'tab', name: 'Cheapest', properties: { selected: true } }),
            node({ ref: '@e2', role: 'button', name: 'Search', properties: { disabled: true } }),
            node({ ref: '@e3', role: 'tab', name: 'Best', properties: { selected: false } }),
            node({ ref: '@e4', role: 'button', name: 'Show filters', properties: { expanded: true } }),
        ]);
        expect(runEvidence(page)).toContain('tab Cheapest [selected=true]');
        expect(runEvidence(page)).toContain('button Search [disabled=true]');
        expect(runEvidence(page)).toContain('button Show filters [expanded=true]');
        const labels = [...runCandidates(page, []).values()].map(choice => choice.label);
        expect(labels).not.toContain('Click tab Cheapest');
        expect(labels).not.toContain('Click button Search');
        expect(labels).toContain('Click tab Best');
    });

    it('keeps itinerary details and keyboard activation in evidence', () => {
        const name = `From 282 US dollars round trip total. ${'Flight detail. '.repeat(16)} Arrives at MEX at 10:10 PM. Select flight`;
        const page = snapshot([node({ role: 'link', name, activation: 'keyboard' })]);
        expect(runEvidence(page)).toContain('Arrives at MEX at 10:10 PM');
        expect(runEvidence(page)).toContain('[activation=keyboard]');
        expect(runCandidates(page, []).get('click_0')?.label).toContain('Arrives at MEX at 10:10 PM');
    });

    it('keeps login links and caps action choices below the provider limit', () => {
        const nodes = Array.from({ length: 500 }, (_, index) =>
            node({ ref: `@e${index}`, role: 'link', name: index ? `Page ${index}` : 'Log in' })
        );
        const choices = runCandidates(snapshot(nodes), []);
        expect(choices.size).toBeLessThanOrEqual(255);
        expect([...choices.values()].some(choice => choice.label === 'Click link Log in')).toBe(true);
    });

    it('requires review for consequential links and unfamiliar buttons', () => {
        const choices = runCandidates(
            snapshot([
                node({ role: 'link', name: 'Delete account' }),
                node({ ref: '@e2', role: 'button', name: 'Finish' }),
            ]),
            []
        );
        expect(choices.get('click_0')?.confirmation).toBe(true);
        expect(choices.get('click_1')?.confirmation).toBe(true);
    });
});
