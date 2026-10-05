// ABOUTME: Private viewer-to-vault HTTP surface. Browser tools cannot invoke owner or secret-bearing operations.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { type BrowserVault, recordChoiceSchema, vaultFillSchema } from './core/vault/service.js';
import { formTargetSchema, identitySchema, shipSchema, VaultError } from './core/vault/types.js';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{40,64}$/);
const ownerTokenSchema = z.string().min(1).max(1024);
const prepareSchema = z
    .object({
        sessionId: z.uuid(),
        handoffId: idSchema,
        target: formTargetSchema,
        expiresAt: z.number().int().positive(),
    })
    .strict();
const authorizeSchema = z.object({ handoffId: idSchema, planet: shipSchema, ownerToken: ownerTokenSchema }).strict();
const ownerSchema = identitySchema.extend({ ownerToken: ownerTokenSchema });

function answer(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(body));
}

export function createVaultHttp(
    vault: BrowserVault,
    serviceToken: string
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
    const expected = Buffer.from(serviceToken);
    return async (request, response) => {
        const header = request.headers['x-browser-vault-service'];
        const actual = Buffer.from(typeof header === 'string' ? header : '');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            answer(response, 403, { error: 'Vault service authorization is required.' });
            return;
        }
        if (request.method !== 'POST') {
            answer(response, 405, { error: 'Use POST.' });
            return;
        }
        const controller = new AbortController();
        const abort = () => {
            if (!response.writableEnded) controller.abort();
        };
        response.once('close', abort);
        try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of request) {
                const bytes = Buffer.from(chunk);
                size += bytes.length;
                if (size > 65_536) throw new VaultError(413, 'Vault request is too large.');
                chunks.push(bytes);
            }
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const signal = controller.signal;
            switch (request.url) {
                case '/internal/vault/prepare': {
                    const args = prepareSchema.parse(body);
                    answer(
                        response,
                        200,
                        await vault.prepare(args.sessionId, args.handoffId, args.target, args.expiresAt, signal)
                    );
                    break;
                }
                case '/internal/vault/authorize': {
                    const args = authorizeSchema.parse(body);
                    answer(response, 200, await vault.authorize(args.handoffId, args.planet, args.ownerToken, signal));
                    break;
                }
                case '/internal/vault/fill':
                    answer(response, 200, await vault.fill(vaultFillSchema.parse(body), signal));
                    break;
                case '/internal/vault/discard': {
                    const args = z.object({ handoffId: idSchema }).strict().parse(body);
                    vault.discard(args.handoffId);
                    answer(response, 200, { ok: true });
                    break;
                }
                case '/internal/vault/cancel': {
                    const args = z.object({ sessionId: z.uuid() }).strict().parse(body);
                    vault.cancelSessionFlow(args.sessionId);
                    answer(response, 200, { ok: true });
                    break;
                }
                case '/internal/vault/list': {
                    const args = ownerSchema.strict().parse(body);
                    answer(response, 200, {
                        accounts: await vault.list({ planet: args.planet, moon: args.moon }, args.ownerToken, signal),
                    });
                    break;
                }
                case '/internal/vault/delete': {
                    const args = ownerSchema.extend({ record: recordChoiceSchema }).strict().parse(body);
                    await vault.delete({ planet: args.planet, moon: args.moon }, args.ownerToken, args.record, signal);
                    answer(response, 200, { ok: true });
                    break;
                }
                default:
                    answer(response, 404, { error: 'Unknown vault operation.' });
            }
        } catch (error) {
            // Validation errors may contain inputs. Only fixed, purpose-written errors cross this boundary.
            const known = error instanceof VaultError;
            answer(
                response,
                known ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503,
                { error: known ? error.message : 'The vault request could not be completed.' }
            );
        } finally {
            response.off('close', abort);
        }
    };
}
