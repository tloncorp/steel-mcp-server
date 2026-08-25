// ABOUTME: Tracing for the core: reads W3C trace context out of a request's _meta, opens one span per
// ABOUTME: tool call, and formats the traceparent this server puts on its own outbound Steel calls.
import { BAGGAGE_META_KEY, TRACEPARENT_META_KEY, TRACESTATE_META_KEY } from '@modelcontextprotocol/server';
import {
    type Context,
    context,
    createTraceState,
    isSpanContextValid,
    propagation,
    ROOT_CONTEXT,
    type Span,
    type SpanContext,
    SpanKind,
    SpanStatusCode,
    TraceFlags,
    type Tracer,
    trace,
} from '@opentelemetry/api';
import { SteelToolError } from './errors.js';
import type { ReleasePath } from './registry.js';
import { SERVER_VERSION } from './version.js';

/** The instrumentation scope every span this server produces is recorded under. */
export const TRACER_NAME = 'steel-mcp';

/** The MCP method a tool call arrives as, recorded so traces can be grouped by wire method. */
const TOOL_CALL_METHOD = 'tools/call';

/**
 * Picks the tracer to use.
 *
 * Falling back to `trace.getTracer` is what makes tracing free and invisible by default: with no
 * provider registered the API hands back a no-op tracer whose spans never record, so nothing has to
 * be configured for the server to behave exactly as it did before.
 */
export function resolveTracer(tracer?: Tracer | undefined): Tracer {
    return tracer ?? trace.getTracer(TRACER_NAME, SERVER_VERSION);
}

export interface SessionReleaseSpanTarget {
    cause: ReleasePath;
    deployment: 'cloud' | 'self_hosted';
    registryBackend: 'memory' | 'redis';
}

/** Emits one low-cardinality internal lifecycle span with no session or caller identity. */
export function recordSessionReleased(tracer: Tracer, target: SessionReleaseSpanTarget): void {
    const span = tracer.startSpan('steel session released', {
        kind: SpanKind.INTERNAL,
        attributes: {
            'steel.session.release_cause': target.cause,
            'steel.deployment': target.deployment,
            'steel.registry.backend': target.registryBackend,
        },
    });
    span.end();
}

/** `version-traceid-spanid-flags`, the only shape the W3C spec allows on the wire. */
const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** How many baggage entries are read from a request. The spec allows 180; clients send a handful. */
const MAX_BAGGAGE_ENTRIES = 64;

/**
 * Reads a `traceparent` value into a span context, or nothing when it is unusable.
 *
 * The value comes from whoever called us, so every field is validated and an all-zero id — which
 * means "no parent" — is refused rather than turned into a span parented on nothing.
 */
export function parseTraceparent(raw: string): SpanContext | undefined {
    const match = TRACEPARENT_PATTERN.exec(raw.trim().toLowerCase());
    if (!match) return undefined;

    // `ff` is forbidden outright; any other future version still carries these first three fields.
    if (match[1] === 'ff') return undefined;

    const spanContext: SpanContext = {
        traceId: match[2]!,
        spanId: match[3]!,
        // Only the sampled bit is defined, so unknown flags are dropped rather than passed on.
        traceFlags: Number.parseInt(match[4]!, 16) & TraceFlags.SAMPLED,
        isRemote: true,
    };
    return isSpanContextValid(spanContext) ? spanContext : undefined;
}

/** Writes a span context as a version-00 `traceparent`, the only version this server emits. */
export function formatTraceparent(spanContext: SpanContext): string {
    const sampled = (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
    return `00-${spanContext.traceId}-${spanContext.spanId}-${sampled ? '01' : '00'}`;
}

function metaString(meta: Record<string, unknown>, key: string): string | undefined {
    const value = meta[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Parses a `baggage` header value, keeping the key and value and discarding entry properties. */
function parseBaggage(raw: string): Record<string, { value: string }> {
    const entries: Record<string, { value: string }> = {};
    for (const member of raw.split(',').slice(0, MAX_BAGGAGE_ENTRIES)) {
        const [pair] = member.split(';');
        const separator = pair?.indexOf('=') ?? -1;
        if (!pair || separator <= 0) continue;
        const key = pair.slice(0, separator).trim();
        if (!key) continue;
        try {
            entries[key] = { value: decodeURIComponent(pair.slice(separator + 1).trim()) };
        } catch {
            // A malformed percent-escape is the client's problem, not a reason to fail the call.
        }
    }
    return entries;
}

/**
 * Builds the parent context for a request from its `_meta`.
 *
 * The 2026-07-28 revision carries W3C trace context in the `traceparent`, `tracestate` and `baggage`
 * `_meta` keys. This reads them directly rather than through the global propagator, so a caller's
 * trace still stitches together whether or not the entrypoint registered one.
 */
export function contextFromRequestMeta(meta: Record<string, unknown> | undefined): Context {
    if (!meta) return ROOT_CONTEXT;

    let parent = ROOT_CONTEXT;
    const traceparent = metaString(meta, TRACEPARENT_META_KEY);
    const spanContext = traceparent ? parseTraceparent(traceparent) : undefined;
    if (spanContext) {
        const tracestate = metaString(meta, TRACESTATE_META_KEY);
        parent = trace.setSpanContext(
            parent,
            tracestate ? { ...spanContext, traceState: createTraceState(tracestate) } : spanContext
        );
    }

    const baggage = metaString(meta, BAGGAGE_META_KEY);
    if (baggage) parent = propagation.setBaggage(parent, propagation.createBaggage(parseBaggage(baggage)));

    return parent;
}

/** The traceparent describing the span currently in flight, or nothing if none is. */
export function activeTraceparent(): string | undefined {
    const spanContext = trace.getSpanContext(context.active());
    return spanContext && isSpanContextValid(spanContext) ? formatTraceparent(spanContext) : undefined;
}

/**
 * Marks a span as failed.
 *
 * Only the error code is recorded, never the message and never an exception event: Steel error prose
 * quotes page titles, page text and final URLs, and none of that belongs in a telemetry backend.
 */
export function recordSpanFailure(span: Span, error: unknown): void {
    span.setAttribute('error.type', error instanceof SteelToolError ? error.code : 'steel_error');
    span.setStatus({ code: SpanStatusCode.ERROR });
}

/** What a tool-call span says about the call. No arguments, no page content, no credential. */
export interface ToolSpanTarget {
    toolName: string;
    profile: string;
    deployment: string;
    /** The one-way principal digest. The credential it came from must never reach a span. */
    principal: string;
}

/** Runs one tool call inside a span parented on the caller's trace context. */
export function withToolCallSpan<T>(
    tracer: Tracer,
    target: ToolSpanTarget,
    meta: Record<string, unknown> | undefined,
    work: (span: Span) => Promise<T>
): Promise<T> {
    return tracer.startActiveSpan(
        `${TOOL_CALL_METHOD} ${target.toolName}`,
        {
            kind: SpanKind.SERVER,
            attributes: {
                'mcp.method.name': TOOL_CALL_METHOD,
                'mcp.tool.name': target.toolName,
                'steel.profile': target.profile,
                'steel.deployment': target.deployment,
                'steel.principal': target.principal,
            },
        },
        contextFromRequestMeta(meta),
        async span => {
            try {
                return await work(span);
            } catch (error) {
                recordSpanFailure(span, error);
                throw error;
            } finally {
                span.end();
            }
        }
    );
}

/** What an outbound Steel REST call records. `path` never carries a query string. */
export interface SteelCallSpanTarget {
    method: string;
    path: string;
    host: string;
    operation: string;
}

/**
 * Runs one outbound Steel REST call inside a client span.
 *
 * The span is named after the operation rather than the path so the name stays low-cardinality when
 * the path holds a session id, and only the path is recorded — a full Steel URL can carry `apiKey`.
 */
export function withSteelCallSpan<T>(tracer: Tracer, target: SteelCallSpanTarget, work: () => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(
        `steel ${target.operation}`,
        {
            kind: SpanKind.CLIENT,
            attributes: {
                'http.request.method': target.method,
                'url.path': target.path,
                'server.address': target.host,
                'steel.operation': target.operation,
            },
        },
        async span => {
            try {
                return await work();
            } catch (error) {
                recordSpanFailure(span, error);
                throw error;
            } finally {
                span.end();
            }
        }
    );
}

/**
 * Runs one CDP operation inside a client span.
 *
 * Connecting is the only CDP step that gets its own span. A span per command would drown a trace,
 * because `browser_wait_for` polls the page for as long as its timeout allows; the commands a tool
 * issues after connecting are covered by the tool-call span around them.
 */
export function withCdpSpan<T>(
    tracer: Tracer,
    operation: string,
    steelSessionId: string,
    work: () => Promise<T>
): Promise<T> {
    return tracer.startActiveSpan(
        `cdp ${operation}`,
        // The CDP URL is deliberately absent: it carries the Steel API key as a query parameter.
        { kind: SpanKind.CLIENT, attributes: { 'steel.session.id': steelSessionId } },
        async span => {
            try {
                return await work();
            } catch (error) {
                recordSpanFailure(span, error);
                throw error;
            } finally {
                span.end();
            }
        }
    );
}
