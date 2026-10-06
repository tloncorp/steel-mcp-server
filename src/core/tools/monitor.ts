import { z } from 'zod';
import type { ServerDeps, ToolHost } from '../context.js';
import { SteelToolError } from '../errors.js';
import { browserMonitorStatusSchema } from '../steel/monitor-status.js';
import { guard, sessionIdSchema, successResult } from './shared.js';

/** Gateway monitoring: no DOM read, lease renewal, navigation, or session touch. */
export function registerSessionMonitor(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'browser_session_monitor',
        {
            title: 'Browser monitoring status',
            description:
                'Read service-owned handoff receipts for monitoring. Does not advance the browser or prove task success.',
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
            inputSchema: z.object({ session_id: sessionIdSchema }).strict(),
            _meta: { ui: { visibility: ['app'] } },
        },
        async (args, ctx) =>
            guard(deps, 'browser_session_monitor', ctx.mcpReq, async () => {
                const record = await deps.registry.resolve(args.session_id, deps.principal);
                if (deps.config.deployment !== 'self_hosted' || !deps.api.getBrowserMonitorStatus)
                    throw new SteelToolError('Browser monitoring is unavailable.', { code: 'steel_error' });
                const status = browserMonitorStatusSchema.parse(
                    await deps.api.getBrowserMonitorStatus(record.steelSessionId, ctx.mcpReq.signal)
                );
                return successResult(
                    { result: 'Browser monitoring status.' },
                    { session_id: args.session_id, monitor: status }
                );
            })
    );
}
