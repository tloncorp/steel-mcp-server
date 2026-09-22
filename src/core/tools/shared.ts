// ABOUTME: Shared plumbing for tool handlers: the handle-to-page resolution that re-authorises on
// ABOUTME: every call, the untrusted-content fence around page text, and uniform error handling.
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../context.js';
import { type EnvelopeSections, successResult } from '../envelope.js';
import { toolErrorResult } from '../errors.js';
import type { BrowserPage } from '../page.js';
import { DEFAULT_MAX_TOKENS, paginate } from '../pagination.js';
import type { HandleRecord } from '../registry.js';
import type { PageSnapshot } from '../snapshot.js';
import { recordBrowserUrl } from '../telemetry.js';
import { fenceUntrusted } from '../untrusted.js';

/** The `session_id` argument shared by every stateful tool. */
export const sessionIdSchema = z.string().describe('Live session_id from browser_session_create.');

export const maxTokensSchema = z
    .number()
    .int()
    .positive()
    .max(100_000)
    .optional()
    .describe(`Cap on the text returned, in tokens. Defaults to ${DEFAULT_MAX_TOKENS}.`);

/** Compact wire representation of a UUID while retaining strict runtime validation. */
export const uuidSchema = z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

export const cursorSchema = z
    .string()
    .optional()
    .describe('Cursor from a previous truncated response, to continue reading where it stopped.');

/**
 * What a tool handler needs from the request it is answering: cancellation, and the `_meta` the
 * caller's trace context arrives in. Taken from the SDK context so it cannot drift from it.
 */
export type ToolRequest = Pick<ServerContext['mcpReq'], 'signal' | '_meta'>;

/**
 * A tool outcome: an ordinary result, or the input_required result a human-in-the-loop handoff
 * returns when a person has to finish the step in the live browser.
 */
export type ToolOutcome = CallToolResult | InputRequiredResult;

/**
 * Converts handler exceptions into tool errors. The registration boundary traces the result,
 * including rejections that occur before a handler runs.
 */
export async function guard(
    _deps: ServerDeps,
    _toolName: string,
    _request: ToolRequest,
    work: () => Promise<ToolOutcome>
): Promise<ToolOutcome> {
    try {
        return await work();
    } catch (error) {
        return toolErrorResult(error);
    }
}

/**
 * Resolves a handle to its live page, re-authorising against this request's own principal.
 *
 * The check is deliberately repeated on every call and never cached from creation time: a
 * handle is an identifier, not a bearer capability, and a leaked one must not grant a stranger
 * a live, possibly logged-in browser.
 */
export async function withPage(
    deps: ServerDeps,
    toolName: string,
    request: ToolRequest,
    sessionId: string,
    work: (page: BrowserPage, record: HandleRecord) => Promise<ToolOutcome>
): Promise<ToolOutcome> {
    return guard(deps, toolName, request, async () => {
        const record = await deps.registry.resolveForAgent(sessionId, deps.principal);
        await deps.registry.touch(sessionId);
        const page = await deps.pool.page(record.steelSessionId, request.signal);
        const initial = page.pageState.lastSnapshot;
        recordBrowserUrl('initial', initial?.url, deps.config.traceUrlPaths);
        try {
            return await work(page, record);
        } finally {
            // A cached pre-action snapshot is not evidence of the final destination.
            const final = page.pageState.lastSnapshot;
            if (final && final !== initial) recordBrowserUrl('final', final.url, deps.config.traceUrlPaths);
        }
    });
}

/** Wraps page-derived text in the provenance fence and applies the token budget with a cursor. */
export function fencedSection(
    body: string,
    provenance: { finalUrl: string; fetchedAt: string },
    options: { maxTokens?: number | undefined; cursor?: string | undefined }
): { text: string; pagination: string | undefined } {
    const page = paginate(body, options);
    const text = fenceUntrusted(page.text, provenance);
    return {
        text,
        pagination: page.truncated
            ? `Truncated at the token budget (about ${page.totalTokens} tokens in total). ` +
              `Call this tool again with cursor="${page.nextCursor}" to continue.`
            : undefined,
    };
}

/** Renders the fixed one-line page-state section shared by the stateful tools. */
export function pageStateLine(snapshot: Pick<PageSnapshot, 'url' | 'title' | 'snapshotId'>): string {
    return `${snapshot.url}${snapshot.title ? ` — ${snapshot.title}` : ''} (snapshot ${snapshot.snapshotId})`;
}

export type Sections = EnvelopeSections;
export { successResult };
