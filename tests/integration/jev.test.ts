import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JEV_INSTRUCTIONS } from '../../src/core/instructions.js';
import { createSteelMcpServer } from '../../src/core/server.js';
import { loginWallPage, plainPage, testDeps } from '../helpers/fakes.js';
import { tracingHarness } from '../helpers/tracing.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(close.splice(0).map(fn => fn()));
});

function decision(action: string, overrides: { goal?: number; confidence?: number; confirmation?: number } = {}) {
    return Response.json({
        model: '~typesafe/jev-1.13',
        answers: {
            action: { type: 'choice', choice: action, confidence: overrides.confidence ?? 1 },
            goal_done: { type: 'noul', noul: overrides.goal ?? (action === 'done' ? 1 : 0) },
            stuck: { type: 'noul', noul: 0 },
            confirmation: { type: 'noul', noul: overrides.confirmation ?? 0 },
        },
        usage: { input_tokens: 100, output_tokens: 5, cost: 0.001 },
    });
}

function depsFor(page = plainPage) {
    return testDeps({ env: { STEEL_LOCAL: 'true', OPENROUTER_API_KEY: 'operator-inference-key' }, page });
}

async function connect(deps = depsFor()) {
    const server = createSteelMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'jev-test', version: '1' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(async () => {
        await client.close();
        await server.close();
    });
    return { client, deps };
}

async function session(deps: ReturnType<typeof depsFor>) {
    return deps.registry.create({
        principal: deps.principal,
        steelSessionId: 'existing-browser',
        expiresAt: Date.now() + 120_000,
    });
}

function searchPage() {
    const page = plainPage();
    page.root.children![0]!.name = 'Search';
    return page;
}

describe('Jev browser runner', () => {
    it('is advertised only with operator inference credentials and prefers run in instructions', async () => {
        const disabled = await connect(testDeps());
        expect((await disabled.client.listTools()).tools.map(tool => tool.name)).not.toContain('browser_run');
        const enabled = await connect();
        expect((await enabled.client.listTools()).tools.map(tool => tool.name)).toContain('browser_run');
        expect(enabled.client.getInstructions()).toContain('Prefer browser_run');
        expect(Buffer.byteLength(JEV_INSTRUCTIONS)).toBeLessThanOrEqual(2048);
    });

    it('reuses the authenticated session, executes an action, then returns completion and measured usage', async () => {
        const deps = depsFor(searchPage);
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(decision('click_0'))
            .mockResolvedValueOnce(decision('done'));
        deps.jevFetch = request;
        const { client } = await connect(deps);
        const record = await session(deps);
        const result = await client.callTool({
            name: 'browser_run',
            arguments: { session_id: record.handle, task: 'Search the site' },
        });
        expect(result.structuredContent).toMatchObject({
            status: 'done',
            session_id: record.handle,
            usage: { calls: 2, input_tokens: 200, cost_usd: 0.002 },
        });
        expect(request.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/alpha/decisions');
        const init = request.mock.calls[0]?.[1];
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer operator-inference-key' });
        const sent = JSON.parse(String(init?.body));
        expect(sent.model).toBe('~typesafe/jev-latest');
        expect(sent.state.origin).toBe('https://example.com');
        expect(String(init?.body)).not.toContain(record.handle);
        expect(deps.api.created).toHaveLength(0);
        expect(deps.pool.closed).toHaveLength(0);
        expect((await deps.registry.resolve(record.handle, deps.principal)).steelSessionId).toBe('existing-browser');
        const calls = deps.pool.fixtureFor(record.steelSessionId)!.sent;
        expect(calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(true);
    });

    it('refuses another tenant before inference or browser access', async () => {
        const deps = depsFor();
        deps.jevFetch = vi.fn();
        const record = await session(deps);
        deps.principal = 'different-owner';
        const { client } = await connect(deps);
        const result = await client.callTool({
            name: 'browser_run',
            arguments: { session_id: record.handle, task: 'Read account' },
        });
        expect(result.isError).toBe(true);
        expect(deps.jevFetch).not.toHaveBeenCalled();
    });

    it('stops at login without sending the page to inference', async () => {
        const deps = depsFor(loginWallPage);
        deps.jevFetch = vi.fn();
        const { client } = await connect(deps);
        const record = await session(deps);
        const result = await client.callTool({
            name: 'browser_run',
            arguments: { session_id: record.handle, task: 'Read account' },
        });
        expect(result.structuredContent).toMatchObject({ status: 'needs_handoff', usage: { calls: 0 } });
        expect(deps.jevFetch).not.toHaveBeenCalled();
    });

    it.each([
        ['click_0', {}, 'needs_confirmation'], // Save is not an automatic navigation button.
        ['done', { goal: 0.1 }, 'needs_review'],
        ['scroll_down', { confidence: 0.2 }, 'uncertain'],
        ['scroll_down', { confirmation: 0.7 }, 'needs_confirmation'],
        ['needs_input', {}, 'needs_input'],
    ] as const)('stops without acting for %s / %j', async (action, overrides, status) => {
        const deps = depsFor();
        const tracing = tracingHarness();
        close.push(() => tracing.shutdown());
        deps.tracer = tracing.tracer;
        deps.jevFetch = vi.fn<typeof fetch>().mockResolvedValue(decision(action, overrides));
        const { client } = await connect(deps);
        const record = await session(deps);
        const result = await client.callTool({
            name: 'browser_run',
            arguments: { session_id: record.handle, task: 'Read the page' },
        });
        expect(result.structuredContent).toMatchObject({ status, steps: [{ executed: false }] });
        const span = tracing.span('tools/call browser_run');
        expect(span.attributes).toMatchObject({
            'browser.outcome': status,
            'browser.run.calls': 1,
            'browser.run.actions_completed': 0,
            'browser.run.input_tokens': 100,
        });
        expect(span.status.code).toBe(SpanStatusCode.UNSET);
        expect(tracing.span('browser decision').parentSpanContext?.spanId).toBe(span.spanContext().spanId);
        expect(
            deps.pool.fixtureFor(record.steelSessionId)!.sent.filter(call => call.method.startsWith('Input.'))
        ).toHaveLength(0);
    });

    it('rejects unoffered actions and keeps provider errors out of results', async () => {
        const deps = depsFor();
        const tracing = tracingHarness();
        close.push(() => tracing.shutdown());
        deps.tracer = tracing.tracer;
        deps.jevFetch = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(decision('execute_arbitrary_js'))
            .mockResolvedValueOnce(new Response('operator-inference-key echoed secret', { status: 401 }));
        const { client } = await connect(deps);
        const record = await session(deps);
        for (const code of ['jev_invalid_response', 'jev_unavailable']) {
            tracing.reset();
            const result = await client.callTool({
                name: 'browser_run',
                arguments: { session_id: record.handle, task: 'Read the page' },
            });
            expect(result.structuredContent).toMatchObject({ status: 'error', error_code: code });
            const span = tracing.span('tools/call browser_run');
            expect(span.status.code).toBe(SpanStatusCode.ERROR);
            expect(span.attributes['error.type']).toBe(code);
            expect(JSON.stringify(span.attributes)).not.toContain('operator-inference-key');
            expect(JSON.stringify(result)).not.toContain('operator-inference-key');
        }
    });

    it('rechecks human control after inference before executing the selected action', async () => {
        const deps = depsFor(searchPage);
        const record = await session(deps);
        deps.jevFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
            await deps.registry.acquireHumanControl(record.handle, deps.principal, 30_000);
            return decision('click_0');
        });
        const { client } = await connect(deps);
        const result = await client.callTool({
            name: 'browser_run',
            arguments: { session_id: record.handle, task: 'Search' },
        });
        expect(result.structuredContent).toMatchObject({
            status: 'error',
            error_code: 'human_control_active',
            steps: [{ executed: false }],
        });
    });

    it('serializes calls across request-scoped servers and releases the lock after a run', async () => {
        const deps = depsFor();
        let finish!: (response: Response) => void;
        let entered!: () => void;
        const started = new Promise<void>(resolve => {
            entered = resolve;
        });
        deps.jevFetch = vi.fn<typeof fetch>().mockImplementation(
            () =>
                new Promise(resolve => {
                    finish = resolve;
                    entered();
                })
        );
        const first = await connect(deps);
        const second = await connect(deps);
        const record = await session(deps);
        const running = first.client.callTool({
            name: 'browser_run',
            arguments: { session_id: record.handle, task: 'Read' },
        });
        await started;
        const busy = await second.client.callTool({
            name: 'browser_act',
            arguments: { session_id: record.handle, action: 'scroll', value: '100' },
        });
        expect(busy.isError).toBe(true);
        expect(JSON.stringify(busy)).toContain('session_busy');
        finish(decision('done'));
        await running;
        const available = await second.client.callTool({
            name: 'browser_snapshot',
            arguments: { session_id: record.handle },
        });
        expect(available.isError).not.toBe(true);
    });

    it('aborts inference at the budget and leaves the browser open', async () => {
        const deps = depsFor();
        deps.jevFetch = vi.fn<typeof fetch>().mockImplementation(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
                })
        );
        const { client } = await connect(deps);
        const record = await session(deps);
        const result = await client.callTool({
            name: 'browser_run',
            arguments: { session_id: record.handle, task: 'Read', max_seconds: 1 },
        });
        expect(result.structuredContent).toMatchObject({ status: 'timeout' });
        expect(deps.pool.closed).toHaveLength(0);
    });

    it.each(['click_0', 'done'])('discards %s if the page changes during inference', async action => {
        const deps = depsFor(searchPage);
        const record = await session(deps);
        deps.jevFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
            deps.pool.fixtureFor(record.steelSessionId)!.setPage({ ...searchPage(), loaderId: 'new-document' });
            return decision(action);
        });
        const { client } = await connect(deps);
        const result = await client.callTool({
            name: 'browser_run',
            arguments: { session_id: record.handle, task: 'Search' },
        });
        expect(result.structuredContent).toMatchObject({ status: 'page_changed', steps: [{ executed: false }] });
    });

    it('enforces step limits and charges inference steps separately', async () => {
        const deps = depsFor(searchPage);
        deps.jevFetch = vi.fn<typeof fetch>().mockImplementation(async () => decision('click_0'));
        const charge = vi.fn().mockResolvedValue(undefined);
        deps.limiter = { charge };
        const { client } = await connect(deps);
        const record = await session(deps);
        const result = await client.callTool({
            name: 'browser_run',
            arguments: { session_id: record.handle, task: 'Search', max_steps: 2 },
        });
        expect(result.structuredContent).toMatchObject({ status: 'max_steps', usage: { calls: 2 } });
        expect(charge).toHaveBeenCalledTimes(3);
    });
});
