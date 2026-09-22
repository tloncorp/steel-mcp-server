// ABOUTME: Unit tests for the W3C trace-context plumbing: what the server accepts from a client's
// ABOUTME: _meta, what it refuses, and the traceparent it puts on its own outbound calls.
import { BAGGAGE_META_KEY, TRACEPARENT_META_KEY, TRACESTATE_META_KEY } from '@modelcontextprotocol/server';
import { context, propagation, ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import {
    activeTraceparent,
    contextFromRequestMeta,
    formatTraceparent,
    parseTraceparent,
    recordBrowserUrl,
    recordToolOutcome,
    traceShip,
} from '../../src/core/telemetry.js';
import { tracingHarness } from '../helpers/tracing.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const SAMPLED = `00-${TRACE_ID}-${SPAN_ID}-01`;

describe('browser trace projection', () => {
    it('bounds ship labels without accepting arbitrary text', () => {
        expect(traceShip(' ~pinser-botter-fildes-magwes ')).toBe('~pinser-botter-fildes-magwes');
        for (const value of [null, '', 'fildes-magwes', '~zod\ninjected', `~${'a'.repeat(130)}`]) {
            expect(traceShip(value)).toBeUndefined();
        }
    });

    it('records origins and configured route templates, never URL secrets or dynamic segments', async () => {
        const harness = tracingHarness();
        try {
            harness.tracer.startActiveSpan('urls', span => {
                recordBrowserUrl('requested', 'https://user:SECRET@example.com/wiki/PRIVATE?token=SECRET#SECRET', [
                    '/wiki/:page',
                ]);
                recordBrowserUrl('final', 'https://viewer.example/s/SECRET?clipboardBridge=true', ['/s/:capability']);
                recordBrowserUrl('initial', 'file:///PRIVATE');
                span.end();
            });
            expect(harness.span('urls').attributes).toEqual({
                'browser.url.requested.origin': 'https://example.com',
                'browser.url.requested.route': '/wiki/:page',
                'browser.url.final.origin': 'https://viewer.example',
            });
        } finally {
            await harness.shutdown();
        }
    });

    it('records returned failures and bounded run statistics without copying evidence', async () => {
        const harness = tracingHarness();
        try {
            harness.tracer.startActiveSpan('result', span => {
                recordToolOutcome(span, {
                    isError: true,
                    content: [{ text: 'SECRET' }],
                    structuredContent: {
                        status: 'timeout',
                        error_code: 'timeout',
                        session_id: 'sess_PRIVATE',
                        steps: [{ attempted: true, executed: false, description: 'SECRET', target: 'SECRET' }],
                        usage: { calls: 1, input_tokens: 100, output_tokens: 5, cost_usd: 0.001, cost_reported: true },
                    },
                });
                span.end();
            });
            const span = harness.span('result');
            expect(span.status.code).toBe(SpanStatusCode.ERROR);
            expect(span.attributes).toMatchObject({
                'browser.outcome': 'timeout',
                'error.type': 'timeout',
                'browser.run.actions_attempted': 1,
                'browser.run.actions_completed': 0,
                'browser.run.input_tokens': 100,
            });
            expect(span.attributes['browser.session.id']).toMatch(/^[a-f0-9]{64}$/);
            expect(JSON.stringify({ attributes: span.attributes, events: span.events })).not.toMatch(/SECRET|PRIVATE/);
        } finally {
            await harness.shutdown();
        }
    });

    it('distinguishes review from an execution failure', async () => {
        const harness = tracingHarness();
        try {
            harness.tracer.startActiveSpan('review', span => {
                recordToolOutcome(span, { structuredContent: { status: 'needs_review' } });
                span.end();
            });
            expect(harness.span('review').attributes['browser.outcome']).toBe('needs_review');
            expect(harness.span('review').status.code).toBe(SpanStatusCode.UNSET);
        } finally {
            await harness.shutdown();
        }
    });
});

describe('parseTraceparent', () => {
    it('reads the trace id, span id and sampled flag from a valid header', () => {
        expect(parseTraceparent(SAMPLED)).toEqual({
            traceId: TRACE_ID,
            spanId: SPAN_ID,
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
        });
    });

    it('marks an unsampled parent as not sampled rather than dropping it', () => {
        expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.traceFlags).toBe(TraceFlags.NONE);
    });

    it('accepts a future version, whose first three fields keep this meaning', () => {
        expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01`)?.traceId).toBe(TRACE_ID);
    });

    it('rejects the forbidden ff version', () => {
        expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeUndefined();
    });

    it('rejects all-zero ids, which carry no parent at all', () => {
        expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeUndefined();
        expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeUndefined();
    });

    it('rejects anything that is not the exact wire shape', () => {
        for (const raw of ['', 'nonsense', `00-${TRACE_ID}-${SPAN_ID}`, `00-${TRACE_ID}-${SPAN_ID}-01-extra`]) {
            expect(parseTraceparent(raw)).toBeUndefined();
        }
    });
});

describe('formatTraceparent', () => {
    it('round-trips a sampled parent', () => {
        expect(formatTraceparent(parseTraceparent(SAMPLED)!)).toBe(SAMPLED);
    });

    it('always writes version 00, the only version this server emits', () => {
        expect(formatTraceparent(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01`)!)).toBe(SAMPLED);
    });
});

describe('contextFromRequestMeta', () => {
    it('is the root context when the request carries no _meta', () => {
        expect(contextFromRequestMeta(undefined)).toBe(ROOT_CONTEXT);
    });

    it('parents on the traceparent the client sent', () => {
        const parent = trace.getSpanContext(contextFromRequestMeta({ [TRACEPARENT_META_KEY]: SAMPLED }));
        expect(parent?.traceId).toBe(TRACE_ID);
        expect(parent?.spanId).toBe(SPAN_ID);
        expect(parent?.isRemote).toBe(true);
    });

    it('carries vendor tracestate through alongside the parent', () => {
        const parent = trace.getSpanContext(
            contextFromRequestMeta({ [TRACEPARENT_META_KEY]: SAMPLED, [TRACESTATE_META_KEY]: 'vendor1=value1' })
        );
        expect(parent?.traceState?.get('vendor1')).toBe('value1');
    });

    it('ignores tracestate with no usable traceparent, because it has nothing to attach to', () => {
        const extracted = contextFromRequestMeta({ [TRACESTATE_META_KEY]: 'vendor1=value1' });
        expect(trace.getSpanContext(extracted)).toBeUndefined();
    });

    it('carries baggage, decoding percent-encoded values', () => {
        const baggage = propagation.getBaggage(
            contextFromRequestMeta({ [BAGGAGE_META_KEY]: 'userId=alice,region=us%20east' })
        );
        expect(baggage?.getEntry('userId')?.value).toBe('alice');
        expect(baggage?.getEntry('region')?.value).toBe('us east');
    });

    it('drops baggage properties rather than treating them as part of the value', () => {
        const baggage = propagation.getBaggage(contextFromRequestMeta({ [BAGGAGE_META_KEY]: 'key=value;prop=1' }));
        expect(baggage?.getEntry('key')?.value).toBe('value');
    });

    it('ignores a malformed traceparent instead of failing the call', () => {
        expect(trace.getSpanContext(contextFromRequestMeta({ [TRACEPARENT_META_KEY]: 'garbage' }))).toBeUndefined();
    });

    it('ignores non-string _meta values, which arrive from an untrusted client', () => {
        const extracted = contextFromRequestMeta({ [TRACEPARENT_META_KEY]: { nested: true }, [BAGGAGE_META_KEY]: 7 });
        expect(trace.getSpanContext(extracted)).toBeUndefined();
        expect(propagation.getBaggage(extracted)).toBeUndefined();
    });
});

describe('activeTraceparent', () => {
    it('is undefined with no span in flight, so no header is sent', () => {
        expect(activeTraceparent()).toBeUndefined();
    });

    it('describes the span that is currently active', async () => {
        const harness = tracingHarness();
        const observed = await harness.tracer.startActiveSpan('outer', async span => {
            const traceparent = activeTraceparent();
            span.end();
            return traceparent;
        });
        const span = harness.span('outer');
        expect(observed).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
        await harness.shutdown();
    });

    it('is undefined again once the span has gone out of scope', () => {
        expect(context.active()).toBe(ROOT_CONTEXT);
        expect(activeTraceparent()).toBeUndefined();
    });
});
