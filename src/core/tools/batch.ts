// ABOUTME: browser_batch runs known browser steps in one call and stops at failures or human boundaries.
// ABOUTME: It returns at most one snapshot at the end and never replays completed mutations.
import { z } from 'zod';
import type { ServerDeps, ToolHost } from '../context.js';
import { batchInteractiveBlockError, SteelToolError } from '../errors.js';
import { inspectInteractiveBlock } from '../mrtr.js';
import { ACTIONS } from '../page.js';
import { snapshotSection } from './browse.js';
import { maxTokensSchema, sessionIdSchema, successResult, withPage } from './shared.js';

const STEP_TOOLS = ['browser_navigate', 'browser_act', 'browser_wait_for'] as const;

const stepSchema = z
    .object({
        tool: z.enum(STEP_TOOLS).describe('Which browser tool to run for this step.'),
        arguments: z
            .object({
                url: z.string().optional().describe('Navigate URL or wait substring.'),
                action: z.enum(ACTIONS).optional(),
                target: z.string().optional(),
                value: z.string().optional(),
                fields: z.array(z.object({ target: z.string(), value: z.string() }).strict()).optional(),
                text: z.string().optional(),
                selector: z.string().optional(),
                timeout_ms: z.number().int().positive().max(120_000).optional(),
            })
            .strict()
            .describe('Arguments for that tool, minus session_id, which the batch already knows.'),
    })
    .strict()
    .superRefine((step, ctx) => {
        const keys = Object.keys(step.arguments).filter(
            key => step.arguments[key as keyof typeof step.arguments] !== undefined
        );
        const allowed =
            step.tool === 'browser_navigate'
                ? new Set(['url'])
                : step.tool === 'browser_act'
                  ? new Set(['action', 'target', 'value', 'fields'])
                  : new Set(['text', 'selector', 'url', 'timeout_ms']);
        const unexpected = keys.filter(key => !allowed.has(key));
        if (unexpected.length) {
            ctx.addIssue({ code: 'custom', message: `${step.tool} does not accept: ${unexpected.join(', ')}` });
        }
        if (step.tool === 'browser_navigate' && !step.arguments.url) {
            ctx.addIssue({ code: 'custom', message: 'browser_navigate requires url' });
        }
        if (step.tool === 'browser_act' && !step.arguments.action) {
            ctx.addIssue({ code: 'custom', message: 'browser_act requires action' });
        }
        if (
            step.tool === 'browser_wait_for' &&
            step.arguments.text === undefined &&
            step.arguments.selector === undefined &&
            step.arguments.url === undefined
        ) {
            ctx.addIssue({ code: 'custom', message: 'browser_wait_for requires text, selector or url' });
        }
    });

export function registerBatch(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'browser_batch',
        {
            title: 'Run several browser steps at once',
            description:
                'Run known reversible steps whose later targets need no fresh read. Stops on failure or ' +
                'login/challenge; hand off the same session and resume only unrun steps. Stop before payment/final confirmation.',
            annotations: { destructiveHint: true, openWorldHint: true },
            inputSchema: z
                .object({
                    session_id: sessionIdSchema,
                    steps: z.array(stepSchema).min(1).max(20).describe('Steps to run in order.'),
                    include_snapshot: z
                        .boolean()
                        .optional()
                        .describe('Return the page structure once, after the last step.'),
                    max_tokens: maxTokensSchema,
                })
                .strict(),
        },
        async (args, ctx) =>
            withPage(deps, 'browser_batch', ctx.mcpReq, args.session_id, async (page, record) => {
                const lines: string[] = [];
                let lastChange = 'No step reported a change.';

                const stopAtBoundary = async (completedSteps: number): Promise<void> => {
                    const inspection = await inspectInteractiveBlock(page);
                    if (!inspection.verdict) return;
                    const remainingSteps = args.steps.length - completedSteps;
                    throw batchInteractiveBlockError(inspection.verdict.block, inspection.finalUrl, record.mitigation, {
                        completedSteps,
                        nextStep: remainingSteps === 0 ? null : completedSteps + 1,
                        remainingSteps,
                        clearableByPerson: inspection.verdict.clearableByPerson,
                    });
                };

                for (const [index, step] of args.steps.entries()) {
                    if (ctx.mcpReq.signal.aborted) throw ctx.mcpReq.signal.reason ?? new Error('Request aborted.');
                    const label = `Step ${index + 1} (${step.tool})`;
                    let completed = false;
                    try {
                        if (step.tool === 'browser_navigate') {
                            if (!step.arguments.url) {
                                throw new SteelToolError('A browser_navigate step needs a url.', {
                                    code: 'invalid_argument',
                                });
                            }
                            const outcome = await page.navigate(step.arguments.url);
                            lines.push(`${label}: opened ${outcome.finalUrl}. ${outcome.changeDescription}`);
                            lastChange = outcome.changeDescription;
                            completed = true;
                        } else if (step.tool === 'browser_act') {
                            if (!step.arguments.action) {
                                throw new SteelToolError('A browser_act step needs an action.', {
                                    code: 'invalid_argument',
                                });
                            }
                            const outcome = await page.act({
                                action: step.arguments.action,
                                target: step.arguments.target,
                                value: step.arguments.value,
                                fields: step.arguments.fields,
                            });
                            lines.push(`${label}: ${outcome.summary} ${outcome.changeDescription}`);
                            lastChange = outcome.changeDescription;
                            completed = true;
                        } else {
                            let outcome: Awaited<ReturnType<typeof page.waitFor>>;
                            try {
                                outcome = await page.waitFor({
                                    text: step.arguments.text,
                                    selector: step.arguments.selector,
                                    url: step.arguments.url,
                                    timeoutMs: step.arguments.timeout_ms,
                                });
                            } catch (error) {
                                if (error instanceof SteelToolError && error.code === 'timeout') {
                                    await stopAtBoundary(index);
                                }
                                throw error;
                            }
                            lines.push(`${label}: waited ${outcome.waitedMs}ms for ${outcome.condition}.`);
                            completed = true;
                        }
                    } catch (error) {
                        if (error instanceof SteelToolError && error.details?.completed_steps !== undefined) {
                            throw error;
                        }
                        const message = error instanceof Error ? error.message : String(error);
                        const failure = new SteelToolError(
                            `${label} failed, so the remaining ${args.steps.length - index - 1} step(s) were not run. ` +
                                `${message}\n\nCompleted before the failure:\n${lines.join('\n') || '(nothing)'}`,
                            {
                                code: error instanceof SteelToolError ? error.code : 'steel_error',
                                details: { failed_step: index + 1, completed_steps: index },
                            }
                        );
                        throw failure;
                    }
                    if (completed) {
                        await deps.registry.touch(args.session_id);
                        if (step.tool === 'browser_navigate' || step.tool === 'browser_act') {
                            await stopAtBoundary(index + 1);
                        }
                    }
                }

                const sections = args.include_snapshot
                    ? await snapshotSection(page, deps, { maxTokens: args.max_tokens })
                    : undefined;

                return successResult(
                    {
                        result: `Ran ${args.steps.length} steps.\n${lines.join('\n')}`,
                        pageState: sections?.pageState,
                        change: lastChange,
                        snapshot: sections?.snapshot,
                        pagination: sections?.pagination,
                    },
                    { steps_completed: args.steps.length }
                );
            })
    );
}
