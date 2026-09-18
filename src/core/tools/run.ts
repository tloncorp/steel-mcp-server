// ABOUTME: Jev chooses bounded actions on an existing tenant-owned browser. It never creates a
// ABOUTME: second browser, generates credential text, or releases the caller's session.
import { z } from 'zod';
import type { ServerDeps, ToolHost } from '../context.js';
import { SteelToolError } from '../errors.js';
import { decide } from '../jev.js';
import { inspectInteractiveBlock } from '../mrtr.js';
import type { ActRequest } from '../page.js';
import type { PageSnapshot } from '../snapshot.js';
import { fenceUntrusted } from '../untrusted.js';
import { sessionIdSchema, successResult, withPage } from './shared.js';

export interface RunInput {
    field: string;
    value: string;
}
interface Candidate {
    label: string;
    action?: ActRequest;
    confirmation?: boolean;
}
const consequential =
    /\b(buy|purchase|pay|place order|checkout|delete|remove account|send|publish|subscribe|unsubscribe|transfer|confirm|book now|reserve now|sign out|log out|save changes)\b/i;
const navigationButton =
    /^(search|go|next|previous|back|continue|show|view|see|find|filter|sort|apply filters|load more|accept cookies|reject cookies|close|open|menu)\b/i;

/** No field values or capability URLs are sent as page evidence. */
export function runEvidence(snapshot: PageSnapshot): string {
    return snapshot.nodes
        .filter(node => !node.sensitive)
        .slice(0, 160)
        .map(node => {
            const state = ['selected', 'disabled', 'checked', 'expanded', 'pressed', 'readonly']
                .flatMap(key => {
                    const value = node.properties?.[key];
                    return typeof value === 'boolean' || value === 'mixed' ? [`[${key}=${value}]`] : [];
                })
                .join(' ');
            return `${node.ref ?? '-'} ${node.role} ${node.name.slice(0, 600)}${state ? ` ${state}` : ''}${node.activation === 'keyboard' ? ' [activation=keyboard]' : ''}${node.inViewport ? '' : ' [off-screen]'}`;
        })
        .join('\n')
        .slice(0, 12_000);
}

export function runCandidates(snapshot: PageSnapshot, inputs: RunInput[]): Map<string, Candidate> {
    const candidates = new Map<string, Candidate>();
    for (const node of snapshot.nodes) {
        if (!node.ref || !node.interactive || node.sensitive || candidates.size >= 220) continue;
        const role = node.role.toLowerCase();
        if (node.properties?.disabled === true) continue;
        if (role === 'tab' && node.properties?.selected === true) continue;
        const label = `${node.role} ${node.name.slice(0, 600)}`;
        if (role === 'textbox' || role === 'searchbox') {
            for (const [index, input] of inputs.entries()) {
                if (!node.name.toLowerCase().includes(input.field.toLowerCase()) || candidates.size >= 220) continue;
                candidates.set(`type_${candidates.size}`, {
                    label: `Fill ${label} with supplied input ${index + 1}`,
                    action: { action: 'type', target: node.ref, value: input.value },
                });
            }
        } else if (['link', 'button', 'tab', 'menuitem', 'option', 'combobox'].includes(role)) {
            candidates.set(`click_${candidates.size}`, {
                label: `Click ${label}`,
                action: { action: 'click', target: node.ref },
                confirmation: consequential.test(node.name) || (role === 'button' && !navigationButton.test(node.name)),
            });
        }
    }
    candidates.set('scroll_down', {
        label: 'Scroll down to reveal more content',
        action: { action: 'scroll', value: '600' },
    });
    candidates.set('scroll_up', { label: 'Scroll up', action: { action: 'scroll', value: '-600' } });
    candidates.set('back', { label: 'Return to the previous page', action: { action: 'go_back' } });
    candidates.set('done', { label: 'Task complete with visible evidence' });
    candidates.set('needs_input', {
        label: 'Need text not supplied or a control unavailable here; return to the main agent',
    });
    candidates.set('needs_confirmation', {
        label: 'Stop before a consequential action for review by the main agent and owner',
    });
    return candidates;
}

export function registerRun(host: ToolHost, deps: ServerDeps): void {
    if (!deps.config.jev) return;
    host.registerTool(
        'browser_run',
        {
            title: 'Complete a browser task',
            description:
                'Preferred for multi-step navigation and search: Jev drives the existing session within a budget. Supply non-secret text inputs explicitly. Stops for login, confirmation, missing input or uncertainty; continue with ordinary browser tools on the same session. Does not release it.',
            annotations: { destructiveHint: true, openWorldHint: true },
            inputSchema: z
                .object({
                    session_id: sessionIdSchema,
                    task: z
                        .string()
                        .min(1)
                        .max(4000)
                        .describe('Concrete navigation or reading goal. Never include credentials.'),
                    inputs: z
                        .array(
                            z.object({ field: z.string().min(1).max(120), value: z.string().min(1).max(1000) }).strict()
                        )
                        .max(10)
                        .optional()
                        .describe(
                            'Non-secret text and matching field label, e.g. Search. No passwords, OTPs or payment data. Typing does not press Enter.'
                        ),
                    max_steps: z.number().int().min(1).max(24).default(12),
                    max_seconds: z.number().int().min(1).max(120).default(60),
                })
                .strict(),
        },
        async (args, ctx) =>
            withPage(deps, 'browser_run', ctx.mcpReq, args.session_id, async (page, record) => {
                const config = deps.config.jev!;
                const timeout = AbortSignal.timeout(
                    Math.max(1, Math.min(args.max_seconds * 1000, record.expiresAt - Date.now()))
                );
                const signal = AbortSignal.any([ctx.mcpReq.signal, timeout]);
                const steps: Array<{
                    step: number;
                    action: string;
                    description: string;
                    target?: string;
                    confidence: number;
                    goal_probability: number;
                    attempted: boolean;
                    executed: boolean;
                }> = [];
                const usage = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_reported: true };
                let status = 'max_steps';
                let model = config.model;
                let snapshot: PageSnapshot | undefined;
                let errorCode: string | undefined;
                let repeated = 0;
                let previous = '';
                const check = async () => {
                    signal.throwIfAborted();
                    await deps.registry.resolveForAgent(args.session_id, deps.principal);
                    await deps.registry.touch(args.session_id);
                    signal.throwIfAborted();
                };
                try {
                    for (let step = 1; step <= args.max_steps; step++) {
                        await check();
                        const block = await inspectInteractiveBlock(page);
                        if (block.verdict) {
                            status = 'needs_handoff';
                            break;
                        }
                        snapshot = await page.snapshot({ interactiveOnly: false });
                        if (snapshot.nodes.some(node => node.sensitive && node.ref)) {
                            status = 'needs_handoff';
                            break;
                        }
                        await check();
                        const evidence = runEvidence(snapshot);
                        const candidates = runCandidates(snapshot, args.inputs ?? []);
                        const criteria = Object.fromEntries(
                            [...candidates].map(([id, candidate]) => [id, candidate.label])
                        );
                        // Meter every inference, not just the outer call, so a run cannot bypass tenant budgets.
                        await deps.limiter?.charge(deps.principal, 'browser_run');
                        usage.calls++;
                        const decision = await decide(
                            config,
                            {
                                task: args.task,
                                origin: new URL(snapshot.url).origin,
                                page: evidence,
                                inputs: (args.inputs ?? []).map(({ field, value }) => ({ field, value })),
                                history: steps.slice(-6),
                            },
                            criteria,
                            signal,
                            deps.jevFetch
                        );
                        usage.input_tokens += decision.usage.input_tokens;
                        usage.output_tokens += decision.usage.output_tokens;
                        usage.cost_usd += decision.usage.cost ?? 0;
                        usage.cost_reported &&= decision.usage.cost !== undefined;
                        model = decision.model;
                        const answers = decision.answers;
                        const chosen = candidates.get(answers.action.choice)!;
                        const trace = {
                            step,
                            action: answers.action.choice,
                            description: chosen.label,
                            target: chosen.action?.target,
                            confidence: answers.action.confidence,
                            goal_probability: answers.goal_done.noul,
                            attempted: false,
                            executed: false,
                        };
                        steps.push(trace);
                        await check();
                        // Completion judgments and actions both require the evidence Jev saw.
                        const fresh = await page.snapshot({ interactiveOnly: false });
                        if (fresh.loaderId !== snapshot.loaderId || runEvidence(fresh) !== evidence) {
                            status = 'page_changed';
                            snapshot = fresh;
                            break;
                        }
                        if (answers.action.choice === 'done') {
                            status = answers.goal_done.noul >= 0.85 ? 'done' : 'needs_review';
                            break;
                        }
                        if (answers.action.choice === 'needs_input') {
                            status = 'needs_input';
                            break;
                        }
                        if (
                            answers.action.choice === 'needs_confirmation' ||
                            chosen.confirmation ||
                            answers.confirmation.noul >= 0.5
                        ) {
                            status = 'needs_confirmation';
                            break;
                        }
                        if (answers.goal_done.noul >= 0.85) {
                            status = 'needs_review';
                            break;
                        }
                        if (answers.stuck.noul >= 0.85) {
                            status = 'stuck';
                            break;
                        }
                        if (answers.action.confidence < 0.5) {
                            status = 'uncertain';
                            break;
                        }
                        const fingerprint = `${snapshot.loaderId}:${evidence}:${answers.action.choice}`;
                        repeated = fingerprint === previous ? repeated + 1 : 0;
                        previous = fingerprint;
                        if (repeated >= 2) {
                            status = 'stuck';
                            break;
                        }
                        await check();
                        if (chosen.action) {
                            trace.attempted = true;
                            await page.act(chosen.action);
                            trace.executed = true;
                        }
                        snapshot = undefined; // Do not present a pre-action snapshot as the final page.
                    }
                    await check();
                    snapshot = await page.snapshot({ interactiveOnly: false });
                } catch (error) {
                    status = ctx.mcpReq.signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'error';
                    errorCode = error instanceof SteelToolError ? error.code : undefined;
                    usage.cost_reported = false;
                    // Do not return provider bodies, typed values, or raw browser exception messages.
                    snapshot = undefined;
                }
                const result = successResult(
                    {
                        result: `Browser run stopped: ${status}. ${steps.filter(step => step.executed).length} action(s) completed. An attempted action may have taken effect even if it returned an error. The runner does not release the session; its usual expiry still applies. Inspect the page before continuing; do not blindly replay actions.`,
                        snapshot: snapshot
                            ? fenceUntrusted(runEvidence(snapshot), {
                                  finalUrl: snapshot.url,
                                  fetchedAt: deps.now().toISOString(),
                              })
                            : undefined,
                    },
                    { session_id: args.session_id, status, error_code: errorCode, model, steps, usage }
                );
                return { ...result, isError: ['error', 'timeout', 'cancelled'].includes(status) };
            })
    );
}
