// ABOUTME: Web-standard hosted MCP boundary: exact routing, DNS-rebinding guards and credential
// ABOUTME: extraction before a fresh request-scoped Steel server is allowed to see the request.
import {
    createMcpHandler,
    hostHeaderValidationResponse,
    type McpHttpHandler,
    originValidationResponse,
} from '@modelcontextprotocol/server';
import type { ServerDeps } from './core/context.js';
import { principalFromCredential } from './core/registry.js';
import { createSteelMcpServer } from './core/server.js';

export interface RequestDepsInput {
    /** Raw Steel credential for clients that must authenticate to Steel on this request. */
    credential: string;
    /** One-way identifier used to authorise every session-handle lookup. */
    principal: string;
    /** The credential-free request passed through to the MCP server factory. */
    request: Request;
}

export interface SteelHttpHandlerOptions {
    /** Host header allowlist, as hostnames without ports. */
    allowedHostnames: string[];
    /** Browser Origin allowlist, as hostnames without schemes or ports. */
    allowedOriginHostnames: string[];
    /**
     * Constructs request-scoped dependencies from the caller's own credential.
     *
     * Shared registries, credential-keyed pools and the cost-weighted request limiter belong behind
     * this seam; the boundary never reuses one caller's Steel clients for another caller.
     * `HostedRuntime` is the implementation this deployment uses, and it supplies all three.
     */
    depsForRequest(input: RequestDepsInput): ServerDeps | Promise<ServerDeps>;
    onerror?: ((error: Error) => void) | undefined;
}

interface CredentialResult {
    credential?: string;
    invalidAuthorization: boolean;
}

/**
 * Header credentials are authoritative; a malformed Authorization header never falls back to a
 * second carrier. X-Api-Key exists for trusted upstream proxies (including an Urbit moon) that
 * already authenticate their caller with that key and cannot rewrite it as a Bearer credential.
 */
function credentialFromRequest(request: Request): CredentialResult {
    const authorization = request.headers.get('authorization');
    if (authorization !== null) {
        const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(authorization);
        return match?.[1] ? { credential: match[1], invalidAuthorization: false } : { invalidAuthorization: true };
    }

    const apiKeyHeader = request.headers.get('x-api-key')?.trim();
    if (apiKeyHeader) return { credential: apiKeyHeader, invalidAuthorization: false };

    const queryCredential = new URL(request.url).searchParams.get('apiKey')?.trim();
    return {
        credential: queryCredential || undefined,
        invalidAuthorization: false,
    };
}

function unauthorized(message: string): Response {
    return Response.json(
        { error: 'unauthorized', message },
        {
            status: 401,
            headers: {
                'cache-control': 'no-store',
                'www-authenticate': 'Bearer realm="steel-mcp"',
            },
        }
    );
}

/** Prevents either credential carrier from reaching logs, errors or the SDK request context. */
function redactRequestCredential(request: Request): Request {
    const url = new URL(request.url);
    url.searchParams.delete('apiKey');
    const safeRequest = new Request(url, request);
    safeRequest.headers.delete('authorization');
    safeRequest.headers.delete('x-api-key');
    return safeRequest;
}

/** Builds the hosted, stateless fetch handler shared by Node and other web-standard runtimes. */
export function createSteelHttpHandler(options: SteelHttpHandlerOptions): McpHttpHandler {
    const mcp = createMcpHandler(
        async context => {
            const credential = context.authInfo?.token;
            const request = context.requestInfo;
            if (!credential || !request) {
                throw new Error('The hosted MCP factory was invoked without authenticated request context.');
            }
            const principal = principalFromCredential(credential);
            const deps = await options.depsForRequest({ credential, principal, request });
            return createSteelMcpServer({ ...deps, principal });
        },
        { legacy: 'stateless', onerror: options.onerror }
    );

    return {
        bus: mcp.bus,
        notify: mcp.notify,
        close: mcp.close,
        fetch: async request => {
            const hostRejection = hostHeaderValidationResponse(request, options.allowedHostnames);
            if (hostRejection) return hostRejection;
            const originRejection = originValidationResponse(request, options.allowedOriginHostnames);
            if (originRejection) return originRejection;

            if (new URL(request.url).pathname !== '/mcp') {
                return new Response('Not found.', { status: 404 });
            }
            if (request.method.toUpperCase() !== 'POST') {
                return new Response('Method not allowed.', { status: 405, headers: { allow: 'POST' } });
            }

            const auth = credentialFromRequest(request);
            if (auth.invalidAuthorization) {
                return unauthorized('Authorization must use a non-empty Bearer token.');
            }
            if (!auth.credential) {
                return unauthorized('Provide a tenant key as Bearer, X-Api-Key, or the apiKey query parameter.');
            }

            const safeRequest = redactRequestCredential(request);
            return mcp.fetch(safeRequest, {
                authInfo: {
                    token: auth.credential,
                    clientId: principalFromCredential(auth.credential),
                    scopes: [],
                },
            });
        },
    };
}
