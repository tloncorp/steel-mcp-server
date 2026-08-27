// ABOUTME: One read-only planner recommends the smallest session recipe and safely projects saved
// ABOUTME: profile and credential metadata without exposing values or expanding the cached tool list.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveInactivityTimeout } from '../config.js';
import type { ServerDeps, ToolHost } from '../context.js';
import { SteelToolError } from '../errors.js';
import { recommendSession, type SessionNeed } from '../session-plan.js';
import type { SteelCredentialSummary, SteelProfileSummary } from '../steel/types.js';
import { guard, successResult } from './shared.js';

const NEEDS = ['long_running', 'protected_text', 'human_captcha', 'persist_profile', 'mobile', 'location'] as const;
const PAGE_SIZE = 20;

const optionsSchema = z
    .object({
        url: z.url().describe('URL.'),
        goal: z.enum(['read', 'interact', 'account']).describe('Mode.'),
        needs: z
            .array(z.enum(NEEDS))
            .max(6)
            .optional()
            .describe('Unique;protected_text=read;captcha!=read/protected_text;persist_profile=account.'),
        minutes: z.number().int().min(1).max(1440).optional().describe('long_running min.'),
        country: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .optional()
            .describe('location ISO.'),
        cursor: z.string().optional().describe('Cursor.'),
    })
    .strict()
    .superRefine((value, ctx) => {
        const needs = value.needs ?? [];
        if (new Set(needs).size !== needs.length) ctx.addIssue({ code: 'custom', message: 'needs must be unique' });
        if (needs.includes('long_running') !== (value.minutes !== undefined))
            ctx.addIssue({ code: 'custom', message: 'minutes is required only with long_running' });
        if (needs.includes('location') !== (value.country !== undefined))
            ctx.addIssue({ code: 'custom', message: 'country is required only with location' });
        if (needs.includes('protected_text') && value.goal !== 'read')
            ctx.addIssue({ code: 'custom', message: 'protected_text requires goal=read' });
        if (needs.includes('human_captcha') && value.goal === 'read')
            ctx.addIssue({ code: 'custom', message: 'human_captcha requires interact or account' });
        if (needs.includes('human_captcha') && needs.includes('protected_text'))
            ctx.addIssue({ code: 'custom', message: 'human_captcha conflicts with protected_text' });
        if (needs.includes('persist_profile') && value.goal !== 'account')
            ctx.addIssue({ code: 'custom', message: 'persist_profile requires goal=account' });
    });

function targetOrigin(raw: string): string {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new SteelToolError('url must be an absolute HTTP(S) URL.', { code: 'invalid_argument' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new SteelToolError('url must be an absolute HTTP(S) URL without user information.', {
            code: 'invalid_argument',
        });
    }
    return parsed.origin;
}

function sortProfiles(items: SteelProfileSummary[]): SteelProfileSummary[] {
    return [...items].sort(
        (a, b) => Number(b.status === 'READY') - Number(a.status === 'READY') || b.updatedAt.localeCompare(a.updatedAt)
    );
}

function sortCredentials(items: SteelCredentialSummary[]): SteelCredentialSummary[] {
    const newest = new Map<string, SteelCredentialSummary>();
    for (const item of items) {
        const key = `${item.origin}\0${item.namespace}`;
        if (!newest.has(key) || item.updatedAt > (newest.get(key)?.updatedAt ?? '')) newest.set(key, item);
    }
    return [...newest.values()].sort(
        (a, b) => a.namespace.localeCompare(b.namespace) || b.updatedAt.localeCompare(a.updatedAt)
    );
}

function page<T>(items: T[], fingerprintInput: unknown, cursor?: string): { items: T[]; next?: string } {
    const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('base64url').slice(0, 12);
    let offset = 0;
    if (cursor) {
        try {
            const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
                offset?: unknown;
                fingerprint?: unknown;
            };
            if (!Number.isInteger(decoded.offset) || decoded.fingerprint !== fingerprint) throw new Error();
            offset = decoded.offset as number;
        } catch {
            throw new SteelToolError('That options cursor is stale or invalid. Start again without cursor.', {
                code: 'invalid_argument',
            });
        }
    }
    const current = items.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + current.length;
    return {
        items: current,
        next:
            nextOffset < items.length
                ? Buffer.from(JSON.stringify({ offset: nextOffset, fingerprint })).toString('base64url')
                : undefined,
    };
}

export function registerSessionOptions(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'browser_session_options',
        {
            title: 'Plan session',
            description: 'Find profiles/credentials; plan setup.',
            annotations: { readOnlyHint: true, openWorldHint: true },
            inputSchema: optionsSchema,
        },
        async (args, ctx) =>
            guard(deps, 'browser_session_options', ctx.mcpReq, async () => {
                const origin = targetOrigin(args.url);
                const needs = (args.needs ?? []) as SessionNeed[];
                const warnings: Array<{ code: string; message: string }> = [];
                if (deps.config.deployment === 'self_hosted' && needs.includes('location')) {
                    const result = {
                        viable: false,
                        target_origin: origin,
                        recommended_tool: 'browser_session_create',
                        effective_defaults: {
                            headless: false,
                            interactive_viewer: true,
                            timeout_ms: deps.config.sessionTimeoutMs,
                            inactivity_timeout_ms: deps.config.inactivityTimeoutMs,
                        },
                        applied_settings: {},
                        rationale: [],
                        warnings: [
                            {
                                code: 'self_hosted_unsupported',
                                message: 'This deployment cannot select a different proxy location per session.',
                            },
                        ],
                        unresolved: [],
                        profiles: [],
                        credentials: [],
                    };
                    return successResult(
                        { result: 'This setup is unavailable on the self-hosted deployment.' },
                        result
                    );
                }

                let details: Awaited<ReturnType<typeof deps.api.getDetails>> = {};
                if (needs.includes('long_running'))
                    details = await deps.api.getDetails(ctx.mcpReq.signal).catch(() => {
                        warnings.push({
                            code: 'account_limits_unavailable',
                            message: 'Could not read account duration limits; the configured default is used.',
                        });
                        return {};
                    });
                const recipe = recommendSession({
                    origin,
                    goal: args.goal,
                    needs,
                    minutes: args.minutes,
                    country: args.country,
                    configuredTimeoutMs: deps.config.sessionTimeoutMs,
                    accountMaxMs: details.maxSessionDuration,
                });
                if (deps.config.deployment === 'self_hosted') {
                    const createTemplate: { configuration?: string } = {};
                    if (recipe.state)
                        createTemplate.configuration = await deps.sessionPlanState.mint(recipe.state, ctx);
                    const timeout = recipe.state?.settings.timeout ?? deps.config.sessionTimeoutMs;
                    const result = {
                        viable: true,
                        target_origin: origin,
                        recommended_tool: recipe.recommendedTool,
                        ...(recipe.recommendedTool === 'browser_scrape'
                            ? { scrape_arguments: { url: args.url } }
                            : { create_template: createTemplate }),
                        effective_defaults: {
                            headless: false,
                            interactive_viewer: true,
                            timeout_ms: timeout,
                            inactivity_timeout_ms:
                                resolveInactivityTimeout(deps.config.inactivityTimeoutMs, timeout) ?? null,
                        },
                        applied_settings: {
                            ...(recipe.state?.settings ?? {}),
                            persistProfile: true,
                            profileScope: 'credential',
                        },
                        rationale: [
                            ...recipe.rationale,
                            'This credential automatically reuses one durable browser profile without keeping Chrome running.',
                        ],
                        warnings: [
                            ...recipe.warnings,
                            ...(needs.includes('human_captcha')
                                ? [
                                      {
                                          code: 'manual_handoff_required',
                                          message: 'CAPTCHA completion requires browser_session_handoff.',
                                      },
                                  ]
                                : []),
                        ],
                        unresolved: [],
                        profiles: [],
                        credentials: [],
                        profile_scope: 'credential',
                    };
                    return successResult(
                        {
                            result:
                                recipe.recommendedTool === 'browser_scrape'
                                    ? `${recipe.recommendedTool} is recommended for ${origin}.`
                                    : `Start the session and use browser_session_handoff if ${origin} needs login; this credential's profile is saved automatically.`,
                        },
                        result
                    );
                }
                let profiles: SteelProfileSummary[] = [];
                let credentials: SteelCredentialSummary[] = [];
                if (args.goal === 'account') {
                    const [profileResult, credentialResult] = await Promise.allSettled([
                        deps.api.listProfiles(ctx.mcpReq.signal),
                        deps.api.listCredentials({ origin }, ctx.mcpReq.signal),
                    ]);
                    if (profileResult.status === 'fulfilled') profiles = sortProfiles(profileResult.value);
                    else
                        warnings.push({ code: 'profiles_unavailable', message: 'Saved profiles could not be listed.' });
                    if (credentialResult.status === 'fulfilled') credentials = sortCredentials(credentialResult.value);
                    else
                        warnings.push({
                            code: 'credentials_unavailable',
                            message: 'Credential metadata could not be listed.',
                        });
                }
                const catalog = [
                    ...profiles.map(item => ({ kind: 'profile' as const, item })),
                    ...credentials.map(item => ({ kind: 'credential' as const, item })),
                ];
                const paged = page(
                    catalog,
                    {
                        origin,
                        goal: args.goal,
                        needs: [...needs].sort(),
                        minutes: args.minutes,
                        country: args.country,
                        catalog,
                    },
                    args.cursor
                );
                const pageProfiles = paged.items
                    .filter(i => i.kind === 'profile')
                    .map(i => i.item as SteelProfileSummary);
                const pageCredentials = paged.items
                    .filter(i => i.kind === 'credential')
                    .map(i => i.item as SteelCredentialSummary);
                const createTemplate: { configuration?: string; namespace?: string } = {};
                if (recipe.state) createTemplate.configuration = await deps.sessionPlanState.mint(recipe.state, ctx);
                if (args.goal === 'account' && credentials.length === 1)
                    createTemplate.namespace = credentials[0]?.namespace;
                const unresolved: Array<{ field: 'profile_id' | 'namespace'; reason: string }> = [];
                if (args.goal === 'account' && profiles.length)
                    unresolved.push({
                        field: 'profile_id',
                        reason: 'Choose a READY profile_id; none is selected automatically.',
                    });
                if (args.goal === 'account' && credentials.length !== 1)
                    unresolved.push({
                        field: 'namespace',
                        reason: credentials.length
                            ? 'Choose one exact-origin namespace.'
                            : 'No exact-origin credential namespace was found.',
                    });
                if (createTemplate.namespace)
                    warnings.push({
                        code: 'managed_login_auto_submit',
                        message: 'A matching login form may submit automatically; stored values remain hidden.',
                    });
                const timeout = recipe.state?.settings.timeout ?? deps.config.sessionTimeoutMs;
                const result = {
                    viable: true,
                    target_origin: origin,
                    recommended_tool: recipe.recommendedTool,
                    ...(recipe.recommendedTool === 'browser_scrape'
                        ? { scrape_arguments: { url: args.url } }
                        : { create_template: createTemplate }),
                    effective_defaults: {
                        headless: false,
                        interactive_viewer: true,
                        timeout_ms: timeout,
                        inactivity_timeout_ms:
                            resolveInactivityTimeout(deps.config.inactivityTimeoutMs, timeout) ?? null,
                    },
                    applied_settings: recipe.state?.settings ?? {},
                    rationale: recipe.rationale,
                    warnings: [...recipe.warnings, ...warnings],
                    unresolved,
                    profiles: pageProfiles.map(p => ({
                        profile_id: p.id,
                        status: p.status,
                        created_at: p.createdAt,
                        updated_at: p.updatedAt,
                    })),
                    credentials: pageCredentials.map(c => ({
                        namespace: c.namespace,
                        origin: c.origin,
                        created_at: c.createdAt,
                        updated_at: c.updatedAt,
                    })),
                    ...(paged.next ? { next_cursor: paged.next } : {}),
                };
                return successResult(
                    {
                        result: `${recipe.recommendedTool} is recommended for ${origin}. ${pageProfiles.length} profiles and ${pageCredentials.length} credential namespaces are shown on this page.`,
                    },
                    result
                );
            })
    );
}
