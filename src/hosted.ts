#!/usr/bin/env node
// ABOUTME: The hosted entrypoint. Builds one shared runtime, serves the /mcp boundary over Node's
// ABOUTME: HTTP server, and releases every browser it started before the replica goes away.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConfig } from './core/config.js';
import { REAPER_INTERVAL_MS, resolveRegistryIdleMs } from './core/lifecycle.js';
import { recordSessionReleased, resolveTracer } from './core/telemetry.js';
import { SERVER_VERSION } from './core/version.js';
import { createHandleRegistryBackend, HostedRuntime, type HostedRuntimeOptions } from './hosted-runtime.js';
import { createSteelHttpHandler } from './http.js';
import { startTracing } from './tracing.js';

const DEFAULT_PORT = 8080;
/** Every interface, because a container's port is only reachable from outside if it binds one. */
const DEFAULT_HOST = '0.0.0.0';

/** Answered before the Host allowlist, since a load balancer probes by IP. */
const HEALTH_PATH = '/healthz';

export type LogLevel = 'info' | 'error';
export type Log = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

export interface HostedServerOptions {
    env: Record<string, string | undefined>;
    /** Test seams for the Steel clients a request gets; production uses the runtime's own. */
    runtime?: Pick<HostedRuntimeOptions, 'createApi' | 'createPool' | 'createLimiter' | 'now'> | undefined;
    log?: Log | undefined;
}

export interface HostedServer {
    /** The bound port, which is the assigned one when `PORT` is 0. */
    port: number;
    /** Stops accepting, then releases every session this replica still holds. */
    close(): Promise<void>;
}

/** Structured JSON on stdout, which is what a hosted log pipeline collects. */
function defaultLog(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    process.stdout.write(`${JSON.stringify({ level, message, at: new Date().toISOString(), ...fields })}\n`);
}

function parsePort(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
    const port = Number.parseInt(raw, 10);
    // 0 is meaningful — it asks the OS for a free port — so this is not the config parser's rule.
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`PORT must be a number between 0 and 65535, got "${raw}".`);
    }
    return port;
}

function parseList(raw: string | undefined): string[] {
    return (raw ?? '')
        .split(',')
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);
}

/**
 * Starts the hosted server.
 *
 * Every caller supplies a credential that becomes its tenant principal. Against Steel Cloud that
 * same credential also authenticates the Steel API client. Against a self-hosted browser it is only
 * a tenant boundary: the local browser needs no credential and never receives it. The environment
 * supplies everything else: the endpoint, profile, timeouts, and optional shared handle store.
 */
export async function startHostedServer(options: HostedServerOptions): Promise<HostedServer> {
    const { env } = options;
    const log = options.log ?? defaultLog;

    const allowedHostnames = parseList(env.STEEL_ALLOWED_HOSTS);
    if (allowedHostnames.length === 0) {
        throw new Error(
            'STEEL_ALLOWED_HOSTS must list the hostnames this endpoint answers on, comma-separated ' +
                '(for example "mcp.steel.dev"). An empty allowlist would reject every request, and no ' +
                'allowlist at all is what DNS rebinding needs.'
        );
    }
    // Absent means no browser origin is allowed. A request with no Origin header still passes, so
    // this only ever constrains browsers, which is exactly what the check defends against.
    const allowedOriginHostnames = parseList(env.STEEL_ALLOWED_ORIGINS);
    const port = parsePort(env.PORT);
    const host = env.HOST?.trim() || DEFAULT_HOST;

    // Built once with a placeholder so a broken profile, timeout or base URL fails here rather than
    // on some caller's first request. The credential is replaced per request and never reused.
    const template = loadConfig({ ...env, STEEL_API_KEY: 'startup-check' });
    for (const warning of template.warnings) log('info', warning);

    // Started before the runtime so the tracer the core resolves is already the real one.
    const tracing = await startTracing(env, { onWarn: message => log('info', message) });

    const backend = createHandleRegistryBackend({
        env,
        onError: error => log('error', 'handle store error', { error: String(error) }),
    });

    const runtime = new HostedRuntime({
        configForCredential: credential => loadConfig({ ...env, STEEL_API_KEY: credential }),
        createRegistry: backend.createRegistry,
        onReapError: error => log('error', 'reaper failed to release a session', { error: String(error) }),
        onReleased: (cause, registryBackend) => {
            log('info', 'browser session released', {
                cause,
                deployment: template.deployment,
                registry_backend: registryBackend,
            });
            recordSessionReleased(resolveTracer(), {
                cause,
                deployment: template.deployment,
                registryBackend,
            });
        },
        ...options.runtime,
    });

    const handler = createSteelHttpHandler({
        allowedHostnames,
        allowedOriginHostnames,
        depsForRequest: runtime.depsForRequest,
        onerror: error => log('error', 'transport error', { error: error.message }),
    });
    const mcp = toNodeHandler(handler, {
        onerror: error => log('error', 'request failed before the MCP handler answered', { error: error.message }),
    });

    const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
        // Ahead of the MCP handler on purpose: a liveness probe arrives with the load balancer's own
        // Host header, which is not a name this endpoint is served under.
        if (request.method === 'GET' && (request.url ?? '').split('?')[0] === HEALTH_PATH) {
            const body = JSON.stringify({ status: 'ok', version: SERVER_VERSION });
            response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(body);
            return;
        }
        void mcp(request, response);
    });

    const reaper = setInterval(() => {
        void runtime.registry.reap({ idleMs: resolveRegistryIdleMs(template.inactivityTimeoutMs) }).catch(error => {
            log('error', 'reaper sweep failed', { error: String(error) });
        });
    }, REAPER_INTERVAL_MS);
    reaper.unref();

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    log('info', 'steel-mcp listening', {
        host,
        port: boundPort,
        path: '/mcp',
        profile: template.profile,
        baseUrl: template.baseUrl,
        handleStore: env.REDIS_URL ? 'shared' : 'in-process',
        server_version: SERVER_VERSION,
    });

    let closed = false;
    return {
        port: boundPort,
        close: async () => {
            if (closed) return;
            closed = true;
            clearInterval(reaper);
            await new Promise<void>(resolve => server.close(() => resolve()));
            await handler.close().catch(() => undefined);
            // Releases every browser this replica still holds, and closes its CDP pools. Steel's own
            // inactivity timeout is the layer underneath; this one reclaims the slot immediately.
            await runtime.close().catch(error => {
                log('error', 'failed to release a session during shutdown', { error: String(error) });
            });
            // After the runtimes, so their shutdown sweep still had a store to read.
            await backend.close().catch(() => undefined);
            // Last, so the spans this shutdown produced are flushed rather than dropped.
            await tracing?.shutdown().catch(error => {
                log('error', 'failed to flush traces during shutdown', { error: String(error) });
            });
        },
    };
}

async function main(): Promise<void> {
    let server: HostedServer;
    try {
        server = await startHostedServer({ env: process.env });
    } catch (error) {
        defaultLog('error', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }

    let shuttingDown = false;
    const shutdown = (cause: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        void (async () => {
            defaultLog('info', 'shutting down', { cause });
            await server.close();
            process.exit(0);
        })();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only when this file is the process entry, so importing it for tests starts nothing.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    void main();
}
