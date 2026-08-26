// ABOUTME: Briefly hosts browser-produced bytes behind signed, unguessable capability URLs so a
// ABOUTME: downstream messaging tool can fetch them without receiving credentials or raw base64.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8001;
const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MIN_SIGNING_KEY_BYTES = 32;
const ARTIFACT_PATH = /^\/artifacts\/([^/]+)\/([^/]+)$/;

export interface PublishedArtifact {
    url: string;
    size: number;
    mimeType: string;
    expiresAt: string;
}

export interface ArtifactPublisher {
    publish(input: { principal: string; data: string; mimeType: string; filename: string }): Promise<PublishedArtifact>;
}

export interface HostedArtifactService extends ArtifactPublisher {
    listen(): Promise<number>;
    close(): Promise<void>;
}

interface ArtifactRecord {
    id: string;
    principalId: string;
    data: Buffer;
    mimeType: string;
    filename: string;
    expiresAt: number;
}

interface CapabilityPayload {
    v: 1;
    aud: 'browser-artifact';
    id: string;
    sub: string;
    exp: number;
}

interface ArtifactConfig {
    publicOrigin: URL;
    secret: string;
    host: string;
    port: number;
    ttlMs: number;
    maxBytes: number;
    maxTotalBytes: number;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    return value;
}

function listenPort(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
        throw new Error('BROWSER_ARTIFACT_PORT must be between 0 and 65535.');
    }
    return value;
}

function loadArtifactConfig(env: Record<string, string | undefined>): ArtifactConfig | undefined {
    const rawOrigin = env.BROWSER_ARTIFACT_PUBLIC_ORIGIN?.trim();
    if (!rawOrigin) return undefined;

    const publicOrigin = new URL(rawOrigin);
    if (publicOrigin.protocol !== 'http:' && publicOrigin.protocol !== 'https:') {
        throw new Error('BROWSER_ARTIFACT_PUBLIC_ORIGIN must use http or https.');
    }
    if (publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) {
        throw new Error('BROWSER_ARTIFACT_PUBLIC_ORIGIN must be an origin without a path, query or fragment.');
    }

    const secret = env.BROWSER_ARTIFACT_SIGNING_KEY?.trim();
    if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_SIGNING_KEY_BYTES) {
        throw new Error(`BROWSER_ARTIFACT_SIGNING_KEY must contain at least ${MIN_SIGNING_KEY_BYTES} bytes.`);
    }

    return {
        publicOrigin,
        secret,
        host: env.BROWSER_ARTIFACT_HOST?.trim() || DEFAULT_HOST,
        port: listenPort(env.BROWSER_ARTIFACT_PORT),
        ttlMs: positiveInteger(env.BROWSER_ARTIFACT_TTL_MS, DEFAULT_TTL_MS, 'BROWSER_ARTIFACT_TTL_MS'),
        maxBytes: positiveInteger(env.BROWSER_ARTIFACT_MAX_BYTES, DEFAULT_MAX_BYTES, 'BROWSER_ARTIFACT_MAX_BYTES'),
        maxTotalBytes: positiveInteger(
            env.BROWSER_ARTIFACT_MAX_TOTAL_BYTES,
            DEFAULT_MAX_TOTAL_BYTES,
            'BROWSER_ARTIFACT_MAX_TOTAL_BYTES'
        ),
    };
}

function safeFilename(raw: string): string {
    const cleaned = raw
        .normalize('NFKC')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 96);
    return cleaned || 'artifact.bin';
}

function sign(encoded: string, secret: string): string {
    return createHmac('sha256', secret).update(encoded).digest('base64url');
}

function principalId(principal: string, secret: string): string {
    return createHmac('sha256', secret).update('browser-artifact-principal\0').update(principal).digest('base64url');
}

function mintCapability(record: ArtifactRecord, secret: string): string {
    const payload: CapabilityPayload = {
        v: 1,
        aud: 'browser-artifact',
        id: record.id,
        sub: record.principalId,
        exp: Math.floor(record.expiresAt / 1_000),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${sign(encoded, secret)}`;
}

function verifyCapability(token: string, secret: string, now: number): CapabilityPayload | undefined {
    if (token.length > 2_048) return undefined;
    const [encoded, supplied, extra] = token.split('.');
    if (!encoded || !supplied || extra !== undefined) return undefined;
    const expectedBytes = Buffer.from(sign(encoded, secret));
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
        return undefined;
    }

    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<CapabilityPayload>;
        if (
            payload.v !== 1 ||
            payload.aud !== 'browser-artifact' ||
            typeof payload.id !== 'string' ||
            typeof payload.sub !== 'string' ||
            !Number.isSafeInteger(payload.exp) ||
            (payload.exp as number) <= Math.floor(now / 1_000)
        ) {
            return undefined;
        }
        return payload as CapabilityPayload;
    } catch {
        return undefined;
    }
}

function sendError(response: import('node:http').ServerResponse, status: number, message: string): void {
    response.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(message);
}

function decodePathSegment(value: string): string | undefined {
    try {
        return decodeURIComponent(value);
    } catch {
        return undefined;
    }
}

class InMemoryHostedArtifactService implements HostedArtifactService {
    private readonly records = new Map<string, ArtifactRecord>();
    private readonly server: Server;
    private totalBytes = 0;
    private listening = false;

    constructor(private readonly config: ArtifactConfig) {
        this.server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', 'http://artifacts.invalid');
            const match = ARTIFACT_PATH.exec(url.pathname);
            if ((request.method !== 'GET' && request.method !== 'HEAD') || !match) {
                sendError(response, 404, 'Not found.');
                return;
            }

            const token = decodePathSegment(match[1]!);
            const requestedFilename = decodePathSegment(match[2]!);
            const payload = token ? verifyCapability(token, this.config.secret, Date.now()) : undefined;
            const record = payload ? this.records.get(payload.id) : undefined;
            if (
                !payload ||
                !record ||
                !requestedFilename ||
                record.principalId !== payload.sub ||
                record.expiresAt <= Date.now() ||
                safeFilename(requestedFilename) !== record.filename
            ) {
                sendError(response, 404, 'Artifact is unavailable or expired.');
                return;
            }

            response.writeHead(200, {
                'content-type': record.mimeType,
                'content-length': String(record.data.byteLength),
                'content-disposition': `inline; filename="${record.filename}"`,
                'cache-control': 'private, no-store, max-age=0',
                'x-content-type-options': 'nosniff',
                'referrer-policy': 'no-referrer',
            });
            response.end(request.method === 'HEAD' ? undefined : record.data);
        });
    }

    private delete(id: string): void {
        const record = this.records.get(id);
        if (!record) return;
        this.records.delete(id);
        this.totalBytes -= record.data.byteLength;
    }

    private prune(now: number): void {
        for (const record of this.records.values()) {
            if (record.expiresAt <= now) this.delete(record.id);
        }
        while (this.totalBytes > this.config.maxTotalBytes) {
            const oldest = this.records.keys().next().value as string | undefined;
            if (!oldest) break;
            this.delete(oldest);
        }
    }

    async publish(input: {
        principal: string;
        data: string;
        mimeType: string;
        filename: string;
    }): Promise<PublishedArtifact> {
        const data = Buffer.from(input.data, 'base64');
        if (data.byteLength < 1 || data.byteLength > this.config.maxBytes) {
            throw new Error(`Artifact must contain between 1 and ${this.config.maxBytes} bytes.`);
        }

        const now = Date.now();
        this.prune(now);
        const record: ArtifactRecord = {
            id: randomUUID(),
            principalId: principalId(input.principal, this.config.secret),
            data,
            mimeType: input.mimeType,
            filename: safeFilename(input.filename),
            expiresAt: now + this.config.ttlMs,
        };
        this.records.set(record.id, record);
        this.totalBytes += data.byteLength;
        this.prune(now);
        if (!this.records.has(record.id)) {
            throw new Error('Artifact exceeds the configured retained-byte budget.');
        }

        const token = mintCapability(record, this.config.secret);
        const url = new URL(
            `/artifacts/${encodeURIComponent(token)}/${encodeURIComponent(record.filename)}`,
            this.config.publicOrigin
        );
        return {
            url: url.toString(),
            size: data.byteLength,
            mimeType: record.mimeType,
            expiresAt: new Date(record.expiresAt).toISOString(),
        };
    }

    async listen(): Promise<number> {
        if (this.listening) throw new Error('Artifact service is already listening.');
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.config.port, this.config.host, () => {
                this.server.removeListener('error', reject);
                resolve();
            });
        });
        this.listening = true;
        const address = this.server.address();
        return typeof address === 'object' && address !== null ? address.port : this.config.port;
    }

    async close(): Promise<void> {
        this.records.clear();
        this.totalBytes = 0;
        if (!this.listening) return;
        this.listening = false;
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
}

export function createHostedArtifactService(
    env: Record<string, string | undefined>
): HostedArtifactService | undefined {
    const config = loadArtifactConfig(env);
    return config ? new InMemoryHostedArtifactService(config) : undefined;
}
