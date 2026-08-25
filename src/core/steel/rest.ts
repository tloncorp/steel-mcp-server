// ABOUTME: Thin typed REST client for the Steel /v1 surface, with the fetch implementation injected
// ABOUTME: so tests exercise the wire shape without a network, and every failure mapped to prose.
import { type Tracer, trace } from '@opentelemetry/api';
import type { SteelConfig } from '../config.js';
import { mapSteelHttpError, type SteelErrorBody, type SteelOperation, SteelToolError } from '../errors.js';
import { activeTraceparent, resolveTracer, withSteelCallSpan } from '../telemetry.js';
import { stripInvisible } from '../untrusted.js';
import type {
    AccountDetails,
    AgentTraceTimeline,
    ArtifactRequest,
    ArtifactResponse,
    CreateSessionRequest,
    ScrapeRequest,
    ScrapeResponse,
    SessionListRequest,
    SessionListResponse,
    SessionLogTimeline,
    SteelApi,
    SteelCredentialSummary,
    SteelProfileSummary,
    SteelSession,
} from './types.js';

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function safeMetadata(value: string, max: number): string {
    return stripInvisible(value).slice(0, max);
}

function profile(value: unknown): SteelProfileSummary | undefined {
    const item = object(value);
    if (!item) return undefined;
    const { id, status, createdAt, updatedAt } = item;
    if (
        typeof id !== 'string' ||
        (status !== 'READY' && status !== 'UPLOADING' && status !== 'FAILED') ||
        typeof createdAt !== 'string' ||
        typeof updatedAt !== 'string'
    )
        return undefined;
    return {
        id: safeMetadata(id, 64),
        status,
        createdAt: safeMetadata(createdAt, 40),
        updatedAt: safeMetadata(updatedAt, 40),
    };
}

function credential(value: unknown): SteelCredentialSummary | undefined {
    const item = object(value);
    if (!item) return undefined;
    const { namespace, origin, createdAt, updatedAt } = item;
    if (
        typeof namespace !== 'string' ||
        typeof origin !== 'string' ||
        typeof createdAt !== 'string' ||
        typeof updatedAt !== 'string'
    )
        return undefined;
    return {
        namespace: safeMetadata(namespace, 100),
        origin: safeMetadata(origin, 2_048),
        createdAt: safeMetadata(createdAt, 40),
        updatedAt: safeMetadata(updatedAt, 40),
    };
}

/** The subset of `fetch` this client uses, so a test can supply a plain function. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface RequestSpec {
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown> | undefined;
    operation: SteelOperation;
    signal?: AbortSignal | undefined;
    /** Defaults to JSON so existing endpoint decoding remains unchanged. */
    responseType?: 'json' | 'text' | 'artifact' | undefined;
    /** Defaults to application/json; text endpoints can request their native media type. */
    accept?: string | undefined;
    /** Endpoint contract used only when a binary response has no useful Content-Type. */
    artifactMimeType?: 'image/jpeg' | 'application/pdf' | undefined;
    /** Statuses answered with `undefined` instead of an error, for idempotent operations. */
    tolerate?: number[] | undefined;
}

function dropUndefined(body: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function artifactMimeType(bytes: Buffer, declared: string | undefined, fallback: string): string {
    if (declared && declared !== 'application/octet-stream') return declared;
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes.subarray(1, 4).equals(Buffer.from('PNG'))) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
    return fallback;
}

async function readErrorBody(response: Response): Promise<SteelErrorBody> {
    try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === 'object') return parsed as SteelErrorBody;
    } catch {
        // A gateway in front of Steel can answer with HTML; fall through to the status-only message.
    }
    return { message: `Steel returned HTTP ${response.status} ${response.statusText}`.trim() };
}

function parseRetryAfter(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (!header) return undefined;
    const seconds = Number.parseInt(header, 10);
    return Number.isFinite(seconds) ? seconds : undefined;
}

/** Typed access to the Steel REST endpoints this server needs. */
export class SteelRestClient implements SteelApi {
    constructor(
        private readonly config: SteelConfig,
        private readonly fetchImpl: FetchLike = globalThis.fetch,
        private readonly tracer: Tracer = resolveTracer()
    ) {}

    /** Wraps every call in a client span, which is also what the outbound traceparent names. */
    private async request<T>(spec: RequestSpec): Promise<T | undefined> {
        return withSteelCallSpan(
            this.tracer,
            {
                method: spec.method,
                path: `/v1${spec.path.replace(/\?.*$/, '')}`,
                host: new URL(this.config.baseUrl).host,
                operation: spec.operation,
            },
            () => this.send<T>(spec)
        );
    }

    private async send<T>(spec: RequestSpec): Promise<T | undefined> {
        const headers: Record<string, string> = { accept: spec.accept ?? 'application/json' };
        if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
        if (spec.body) headers['content-type'] = 'application/json';
        // Only set when something is actually tracing, so an untraced deployment sends what it always did.
        const traceparent = activeTraceparent();
        if (traceparent) headers.traceparent = traceparent;

        const init: RequestInit = { method: spec.method, headers };
        if (spec.body) init.body = JSON.stringify(dropUndefined(spec.body));
        if (spec.signal) init.signal = spec.signal;

        let response: Response;
        try {
            response = await this.fetchImpl(`${this.config.baseUrl}/v1${spec.path}`, init);
        } catch (cause) {
            if (spec.signal?.aborted) {
                throw new SteelToolError('The request was cancelled by the caller.', { code: 'timeout' });
            }
            throw new SteelToolError(
                `Could not reach Steel at ${this.config.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
                { code: 'steel_error' }
            );
        }

        trace.getActiveSpan()?.setAttribute('http.response.status_code', response.status);

        if (spec.tolerate?.includes(response.status)) return undefined;

        if (!response.ok) {
            throw mapSteelHttpError(response.status, await readErrorBody(response), {
                operation: spec.operation,
                retryAfterSeconds: parseRetryAfter(response),
            });
        }

        if (response.status === 204) return undefined;
        if (spec.responseType === 'text') return (await response.text()) as T;
        if (spec.responseType === 'artifact') {
            const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
            if (mimeType === 'application/json' || mimeType?.endsWith('+json')) {
                const artifact = (await response.json()) as { url?: unknown };
                if (typeof artifact.url !== 'string' || !artifact.url) {
                    throw new SteelToolError(`Steel returned an invalid artifact response for ${spec.path}.`, {
                        code: 'steel_error',
                    });
                }
                return { kind: 'hosted', url: artifact.url } as T;
            }

            const bytes = Buffer.from(await response.arrayBuffer());
            return {
                kind: 'inline',
                data: bytes.toString('base64'),
                mimeType: artifactMimeType(bytes, mimeType, spec.artifactMimeType ?? 'application/octet-stream'),
                size: bytes.byteLength,
            } as T;
        }
        return (await response.json()) as T;
    }

    private async requireJson<T>(spec: RequestSpec): Promise<T> {
        const result = await this.request<T>(spec);
        if (result === undefined) {
            throw new SteelToolError(`Steel returned an empty body for ${spec.path}.`, { code: 'steel_error' });
        }
        return result;
    }

    private async requireText(spec: RequestSpec): Promise<string> {
        const result = await this.request<string>({ ...spec, responseType: 'text' });
        if (result === undefined) {
            throw new SteelToolError(`Steel returned an empty body for ${spec.path}.`, { code: 'steel_error' });
        }
        return result;
    }

    async scrape(request: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResponse> {
        return this.requireJson<ScrapeResponse>({
            method: 'POST',
            path: '/scrape',
            operation: 'browser_tool',
            signal,
            body: {
                url: request.url,
                format: request.format,
                delay: request.delay,
                useProxy: request.useProxy,
                screenshot: request.screenshot,
                pdf: request.pdf,
            },
        });
    }

    async screenshot(request: ArtifactRequest, signal?: AbortSignal): Promise<ArtifactResponse> {
        const result = await this.request<ArtifactResponse>({
            method: 'POST',
            path: '/screenshot',
            operation: 'browser_tool',
            signal,
            responseType: 'artifact',
            accept: 'application/json, image/png, image/jpeg',
            artifactMimeType: 'image/jpeg',
            body: {
                url: request.url,
                fullPage: request.fullPage,
                delay: request.delay,
                useProxy: request.useProxy,
            },
        });
        if (!result) throw new SteelToolError('Steel returned an empty body for /screenshot.', { code: 'steel_error' });
        return result;
    }

    async pdf(request: ArtifactRequest, signal?: AbortSignal): Promise<ArtifactResponse> {
        const result = await this.request<ArtifactResponse>({
            method: 'POST',
            path: '/pdf',
            operation: 'browser_tool',
            signal,
            responseType: 'artifact',
            accept: 'application/json, application/pdf',
            artifactMimeType: 'application/pdf',
            body: { url: request.url, delay: request.delay, useProxy: request.useProxy },
        });
        if (!result) throw new SteelToolError('Steel returned an empty body for /pdf.', { code: 'steel_error' });
        return result;
    }

    async createSession(request: CreateSessionRequest, signal?: AbortSignal): Promise<SteelSession> {
        return this.requireJson<SteelSession>({
            method: 'POST',
            path: '/sessions',
            operation: 'session_create',
            signal,
            body: { ...request },
        });
    }

    async releaseSession(sessionId: string, signal?: AbortSignal): Promise<void> {
        await this.request({
            method: 'POST',
            path: `/sessions/${encodeURIComponent(sessionId)}/release`,
            operation: 'session_release',
            signal,
            // Releasing an already-released or unknown session is a no-op, not a failure.
            tolerate: [404],
        });
    }

    /** Lists organization sessions newest-first so a finished session can be inspected by id. */
    async listSessions(request: SessionListRequest, signal?: AbortSignal): Promise<SessionListResponse> {
        const query = new URLSearchParams();
        if (request.status) query.set('status', request.status);
        if (request.limit !== undefined) query.set('limit', String(request.limit));
        if (request.cursorId) query.set('cursorId', request.cursorId);
        const suffix = query.toString();
        const result = await this.requireJson<SessionListResponse>({
            method: 'GET',
            path: `/sessions${suffix ? `?${suffix}` : ''}`,
            operation: 'account',
            signal,
        });
        return { ...result, sessions: Array.isArray(result.sessions) ? result.sessions : [] };
    }

    async getSession(sessionId: string, signal?: AbortSignal): Promise<SteelSession> {
        return this.requireJson<SteelSession>({
            method: 'GET',
            path: `/sessions/${encodeURIComponent(sessionId)}`,
            operation: 'account',
            signal,
        });
    }

    /** Reads the durable recording playlist for a finished, headed session. */
    async getSessionHls(sessionId: string, signal?: AbortSignal): Promise<string> {
        const playlist = await this.requireText({
            method: 'GET',
            path: `/sessions/${encodeURIComponent(sessionId)}/hls`,
            operation: 'account',
            signal,
            accept: 'application/vnd.apple.mpegurl',
        });
        if (!/^#EXTM3U(?:\r?\n|$)/.test(playlist)) {
            // Never include the body here: a playlist contains presigned recording URLs.
            throw new SteelToolError('Steel returned an invalid HLS playlist.', { code: 'steel_error' });
        }
        return playlist;
    }

    async getDetails(signal?: AbortSignal): Promise<AccountDetails> {
        return this.requireJson<AccountDetails>({
            method: 'GET',
            path: '/details',
            operation: 'account',
            signal,
        });
    }

    async listProfiles(signal?: AbortSignal): Promise<SteelProfileSummary[]> {
        const raw = await this.requireJson<unknown>({ method: 'GET', path: '/profiles', operation: 'account', signal });
        const items = object(raw)?.profiles;
        if (!Array.isArray(items))
            throw new SteelToolError('Steel returned an invalid profile catalog.', { code: 'steel_error' });
        return items.map(profile).filter((item): item is SteelProfileSummary => item !== undefined);
    }

    async getProfile(profileId: string, signal?: AbortSignal): Promise<SteelProfileSummary> {
        const raw = await this.requireJson<unknown>({
            method: 'GET',
            path: `/profiles/${encodeURIComponent(profileId)}`,
            operation: 'account',
            signal,
        });
        const projected = profile(raw);
        if (!projected) throw new SteelToolError('Steel returned invalid profile metadata.', { code: 'steel_error' });
        return projected;
    }

    async listCredentials(
        request: { origin: string; namespace?: string },
        signal?: AbortSignal
    ): Promise<SteelCredentialSummary[]> {
        const query = new URLSearchParams({ origin: request.origin });
        if (request.namespace !== undefined) query.set('namespace', request.namespace);
        const raw = await this.requireJson<unknown>({
            method: 'GET',
            path: `/credentials?${query}`,
            operation: 'account',
            signal,
        });
        const items = object(raw)?.credentials;
        if (!Array.isArray(items))
            throw new SteelToolError('Steel returned an invalid credential catalog.', { code: 'steel_error' });
        return items
            .map(credential)
            .filter(
                (item): item is SteelCredentialSummary =>
                    item !== undefined &&
                    item.origin === request.origin &&
                    (request.namespace === undefined || item.namespace === request.namespace)
            );
    }

    /**
     * Reads the trace timeline, which arrives as an `{events,total,hasMore}` envelope rather than a
     * bare array. The envelope is passed through so a caller can see that Steel holds more activity
     * than it sent; only a missing `events` is normalised, so a shape surprise cannot become a
     * TypeError in a renderer.
     */
    async getAgentTraces(sessionId: string, signal?: AbortSignal): Promise<AgentTraceTimeline> {
        const timeline = await this.requireJson<AgentTraceTimeline>({
            method: 'GET',
            path: `/sessions/${encodeURIComponent(sessionId)}/agent-traces`,
            operation: 'account',
            signal,
        });
        return { ...timeline, events: Array.isArray(timeline.events) ? timeline.events : [] };
    }

    /** Reads the session log, which uses the same envelope as `agent-traces` and is normalised alike. */
    async getSessionLogs(sessionId: string, signal?: AbortSignal): Promise<SessionLogTimeline> {
        const timeline = await this.requireJson<SessionLogTimeline>({
            method: 'GET',
            path: `/sessions/${encodeURIComponent(sessionId)}/logs`,
            operation: 'account',
            signal,
        });
        return { ...timeline, events: Array.isArray(timeline.events) ? timeline.events : [] };
    }
}
