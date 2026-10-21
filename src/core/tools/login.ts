// ABOUTME: Discover credential metadata or request a policy-authorized login on the current site.
// ABOUTME: Passwords and encryption factors never enter model-visible results.
import { z } from 'zod';
import type { ServerDeps, ToolHost } from '../context.js';
import { SteelToolError } from '../errors.js';
import { formFieldSelectorsSchema } from '../steel/selected-form.js';
import type { LoginOutcome } from '../vault/types.js';
import { guard, successResult, uuidSchema } from './shared.js';

const messages: Record<LoginOutcome['status'], string> = {
    approval_required:
        'The saved login requires owner approval. Open the secure browser handoff; a chat reply does not authorize credential use.',
    no_match: 'No saved login matches this form. Open the secure browser handoff for the owner.',
    choice_required: 'Several saved accounts match. Open the secure browser handoff so the owner can choose.',
    filled: 'Saved login fields were filled securely. No button was clicked. Inspect the page and choose the next action; filling does not confirm sign-in or authorize any other action.',
    needs_input: 'This login needs the owner. Open the secure browser handoff; do not repeat or guess credentials.',
    unavailable:
        'Saved logins are unavailable for this session. The owner can still enter credentials through the secure browser handoff.',
};

export function registerLogin(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'browser_login',
        {
            title: 'Saved logins',
            description:
                'Saved credentials: list login/password metadata or autofill selected fields using allowed logins. Use requires fields from a current snapshot; never submits.',
            annotations: { destructiveHint: true, openWorldHint: true },
            inputSchema: z
                .object({
                    session_id: z.string(),
                    action: z.enum(['list', 'use']).default('use'),
                    fields: formFieldSelectorsSchema.optional(),
                    record: z.object({ id: uuidSchema, revision: z.number().int().positive() }).strict().optional(),
                })
                .strict(),
        },
        (args, ctx) =>
            guard(deps, 'browser_login', ctx.mcpReq, async () => {
                const record = await deps.registry.resolveForAgent(args.session_id, deps.principal);
                if (args.action === 'use' && !args.fields)
                    throw new SteelToolError(
                        'Select the login fields from a fresh snapshot before using saved credentials.',
                        { code: 'invalid_argument' }
                    );
                const selection =
                    args.action === 'use'
                        ? await (await deps.pool.page(record.steelSessionId, ctx.mcpReq.signal)).selectFormFields(
                              args.fields!
                          )
                        : undefined;
                let outcome: LoginOutcome = { status: 'unavailable' };
                if (deps.vault) {
                    try {
                        if (args.action === 'list')
                            return successResult(
                                { result: 'Saved logins for this site.' },
                                {
                                    session_id: record.handle,
                                    accounts: await deps.vault.discover(record, ctx.mcpReq.signal),
                                }
                            );
                        outcome = await deps.vault.login(record, selection!, ctx.mcpReq.signal, args.record);
                    } catch {
                        /* Service failures are deliberately summarized without remote data. */
                    }
                }
                const nextStep =
                    outcome.status === 'approval_required'
                        ? `Wait for the owner to approve the secure form card. Do not retry login or create another session while waiting. If no card arrived, send one using the Tlon tool command "browser approve-login ${record.handle} --fields '${JSON.stringify(args.fields).replaceAll("'", '\\u0027')}'". Approval happens in the card, not in chat.`
                        : messages[outcome.status];
                return successResult(
                    { result: nextStep },
                    { session_id: record.handle, login: outcome, next_step: nextStep }
                );
            })
    );
}
