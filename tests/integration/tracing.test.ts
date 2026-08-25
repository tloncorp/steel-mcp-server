// ABOUTME: Integration tests for tool-call tracing driven through a real MCP client: one span per
// ABOUTME: call, parent linkage from the caller's _meta, and no credential anywhere in a span.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, TRACEPARENT_META_KEY } from '@modelcontextprotocol/server';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { principalFromCredential } from '../../src/core/registry.js';
import { createSteelMcpServer } from '../../src/core/server.js';
import { TEST_API_KEY, testDeps } from '../helpers/fakes.js';
import { type TracingHarness, tracingHarness } from '../helpers/tracing.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

type Deps = ReturnType<typeof testDeps>;

interface Harness {
    client: Client;
    deps: Deps;
    tracing: TracingHarness;
    close(): Promise<void>;
}

async function connect(): Promise<Harness> {
    const tracing = tracingHarness();
    const deps = testDeps({ tracer: tracing.tracer });
    const server = createSteelMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tracing-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
        client,
        deps,
        tracing,
        close: async () => {
            await client.close();
            await server.close();
            await tracing.shutdown();
        },
    };
}

let harness: Harness;

beforeEach(async () => {
    harness = await connect();
});

afterEach(async () => {
    await harness.close();
});

describe('tool-call spans', () => {
    it('records exactly one span per tool call, named after the method and the tool', async () => {
        await harness.client.callTool({ name: 'browser_scrape', arguments: { url: 'https://example.com' } });

        const spans = harness.tracing.spans();
        expect(spans).toHaveLength(1);
        expect(spans[0]!.name).toBe('tools/call browser_scrape');
        expect(spans[0]!.kind).toBe(SpanKind.SERVER);
        expect(spans[0]!.status.code).toBe(SpanStatusCode.UNSET);
    });

    it('carries the tool name, the profile and the principal digest, and nothing else', async () => {
        await harness.client.callTool({ name: 'browser_scrape', arguments: { url: 'https://example.com' } });

        expect(harness.tracing.span('tools/call browser_scrape').attributes).toEqual({
            'mcp.method.name': 'tools/call',
            'mcp.tool.name': 'browser_scrape',
            'steel.profile': 'browse',
            'steel.deployment': 'cloud',
            'steel.principal': principalFromCredential(TEST_API_KEY),
        });
    });

    it('traces a stateful tool the same way', async () => {
        const created = await harness.client.callTool({ name: 'browser_session_create', arguments: {} });
        const sessionId = (created as { structuredContent?: { session_id?: string } }).structuredContent?.session_id;
        harness.tracing.reset();

        await harness.client.callTool({
            name: 'browser_navigate',
            arguments: { session_id: sessionId, url: 'https://example.com/next' },
        });

        expect(harness.tracing.span('tools/call browser_navigate').attributes['mcp.tool.name']).toBe('browser_navigate');
    });

    it('starts a root span when the caller sends no trace context', async () => {
        await harness.client.callTool({ name: 'browser_scrape', arguments: { url: 'https://example.com' } });
        expect(harness.tracing.span('tools/call browser_scrape').parentSpanContext).toBeUndefined();
    });
});

describe('session-release spans', () => {
    it('records one allow-listed lifecycle cause and no session identity', async () => {
        const created = await harness.client.callTool({ name: 'browser_session_create', arguments: {} });
        const sessionId = (created as { structuredContent?: { session_id?: string } }).structuredContent?.session_id;
        harness.tracing.reset();

        await harness.client.callTool({ name: 'browser_session_release', arguments: { session_id: sessionId } });

        const release = harness.tracing.span('steel session released');
        expect(release.kind).toBe(SpanKind.INTERNAL);
        expect(release.attributes).toEqual({
            'steel.session.release_cause': 'explicit',
            'steel.deployment': 'cloud',
            'steel.registry.backend': 'memory',
        });
        expect(JSON.stringify(release.attributes)).not.toMatch(
            /handle|principal|profile|url|page|credential|token|cookie/i
        );
    });
});

describe('inbound trace context', () => {
    it('parents the tool span on the traceparent the client put in _meta', async () => {
        await harness.client.callTool({
            name: 'browser_scrape',
            arguments: { url: 'https://example.com' },
            _meta: { [TRACEPARENT_META_KEY]: `00-${TRACE_ID}-${SPAN_ID}-01` },
        });

        const span = harness.tracing.span('tools/call browser_scrape');
        expect(span.spanContext().traceId).toBe(TRACE_ID);
        expect(span.parentSpanContext?.spanId).toBe(SPAN_ID);
    });

    it('ignores an unusable traceparent and traces the call anyway', async () => {
        await harness.client.callTool({
            name: 'browser_scrape',
            arguments: { url: 'https://example.com' },
            _meta: { [TRACEPARENT_META_KEY]: 'not-a-traceparent' },
        });

        const span = harness.tracing.span('tools/call browser_scrape');
        expect(span.parentSpanContext).toBeUndefined();
        expect(span.spanContext().traceId).not.toBe(TRACE_ID);
    });
});

describe('failed tool calls', () => {
    it('marks the span as failed with the error code, and still answers the caller', async () => {
        const result = await harness.client.callTool({
            name: 'browser_navigate',
            arguments: { session_id: 'sess_nope', url: 'https://example.com' },
        });

        expect((result as { isError?: boolean }).isError).toBe(true);
        const span = harness.tracing.span('tools/call browser_navigate');
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(span.attributes['error.type']).toBe('not_found');
    });

    it('records no exception message, which can quote page content', async () => {
        await harness.client.callTool({
            name: 'browser_navigate',
            arguments: { session_id: 'sess_nope', url: 'https://example.com' },
        });

        const span = harness.tracing.span('tools/call browser_navigate');
        expect(span.events).toEqual([]);
        expect(span.status.message).toBeUndefined();
    });
});

describe('span redaction', () => {
    it('never puts the credential in a span, even though the config holds it', async () => {
        expect(harness.deps.config.apiKey).toBe(TEST_API_KEY);
        await harness.client.callTool({ name: 'browser_scrape', arguments: { url: 'https://example.com' } });
        await harness.client.callTool({ name: 'browser_session_create', arguments: {} });
        await harness.client.callTool({
            name: 'browser_navigate',
            arguments: { session_id: 'sess_nope', url: 'https://example.com' },
        });

        const recorded = JSON.stringify(
            harness.tracing.spans().map(span => ({
                name: span.name,
                attributes: span.attributes,
                status: span.status,
                events: span.events,
            }))
        );
        expect(recorded).not.toContain(TEST_API_KEY);
        expect(recorded).toContain(principalFromCredential(TEST_API_KEY));
    });
});

describe('response bytes', () => {
    it('are identical whether or not a tracer is recording', async () => {
        const at = () => new Date('2026-07-30T12:00:00.000Z');

        const tracing = tracingHarness();
        const traced = testDeps({ tracer: tracing.tracer });
        traced.now = at;
        const untraced = testDeps();
        untraced.now = at;

        const results: string[] = [];
        for (const deps of [traced, untraced]) {
            const server = createSteelMcpServer(deps);
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const client = new Client({ name: 'bytes', version: '1.0.0' });
            await server.connect(serverTransport);
            await client.connect(clientTransport);
            results.push(
                JSON.stringify(
                    await client.callTool({ name: 'browser_scrape', arguments: { url: 'https://example.com' } })
                )
            );
            await client.close();
            await server.close();
        }

        expect(tracing.spans()).toHaveLength(1);
        expect(results[0]).toBe(results[1]);
        await tracing.shutdown();
    });
});
