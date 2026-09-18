// ABOUTME: A process-owned session has one page-operation writer while a Jev run is in flight.
// ABOUTME: Request-scoped MCP servers share the lock through their common handle registry.
import type { ServerDeps, ToolHost } from './context.js';
import { SteelToolError, toolErrorResult } from './errors.js';
import type { HandleRegistry } from './registry.js';

const operations = new WeakMap<HandleRegistry, Set<string>>();
const pageTools = new Set([
    'browser_run',
    'browser_navigate',
    'browser_act',
    'browser_batch',
    'browser_snapshot',
    'browser_find',
    'browser_wait_for',
    'browser_screenshot',
    'browser_session_release',
]);
type Register = (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => unknown;

export function operationHost(host: ToolHost, deps: ServerDeps): ToolHost {
    let active = operations.get(deps.registry);
    if (!active) {
        active = new Set();
        operations.set(deps.registry, active);
    }
    const register = host.registerTool.bind(host) as unknown as Register;
    const wrapped: Register = (name, config, handler) =>
        register(name, config, async (...args) => {
            const input = args[0] as { session_id?: unknown } | undefined;
            const handle = input?.session_id;
            if (typeof handle !== 'string') return handler(...args);
            const key = `${deps.principal}:${handle}`;
            // Human takeover calls cannot overlap a run, but never hold this lock while eliciting.
            if (active.has(key))
                return toolErrorResult(
                    new SteelToolError(
                        'This session has an operation in progress. Wait for it to finish or cancel it before continuing.',
                        { code: 'session_busy' }
                    )
                );
            if (!pageTools.has(name)) return handler(...args);
            active.add(key);
            try {
                return await handler(...args);
            } finally {
                active.delete(key);
            }
        });
    return { registerTool: wrapped as unknown as ToolHost['registerTool'], server: host.server };
}
