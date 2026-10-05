// ABOUTME: Use an exact-origin saved login without exposing credentials, selectors, or account lists to the model.
import { z } from 'zod';
import type { ServerDeps, ToolHost } from '../context.js';
import type { LoginOutcome } from '../vault/types.js';
import { guard, sessionIdSchema, successResult } from './shared.js';

const messages: Record<LoginOutcome['status'], string> = {
    no_match: 'No saved login matches this form. Open the secure browser handoff for the owner.',
    choice_required: 'Several saved accounts match. Open the secure browser handoff so the owner can choose.',
    filled: 'Saved login fields were filled securely. Inspect the resulting page; filling does not confirm sign-in or authorize any other action.',
    needs_input: 'This login needs the owner. Open the secure browser handoff; do not repeat or guess credentials.',
    unavailable:
        'Saved logins are unavailable for this session. The owner can still enter credentials through the secure browser handoff.',
};

export function registerLogin(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'browser_login',
        {
            title: 'Use a saved login',
            description:
                'Use a saved login on the current exact HTTPS origin, then attempt safe sign-in. Call when a login form appears. Returns status only; never returns credentials. Hand off when input or account selection is needed.',
            annotations: { destructiveHint: true, openWorldHint: true },
            inputSchema: z.object({ session_id: sessionIdSchema }).strict(),
        },
        (args, ctx) =>
            guard(deps, 'browser_login', ctx.mcpReq, async () => {
                const record = await deps.registry.resolveForAgent(args.session_id, deps.principal);
                let outcome: LoginOutcome = { status: 'unavailable' };
                if (deps.vault) {
                    try {
                        outcome = await deps.vault.login(record, ctx.mcpReq.signal);
                    } catch {
                        /* Service failures are deliberately summarized without remote data. */
                    }
                }
                return successResult(
                    { result: messages[outcome.status] },
                    { session_id: record.handle, login: outcome }
                );
            })
    );
}
