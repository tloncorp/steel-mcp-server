import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vitest';
import { createSteelMcpServer } from '../../src/core/server.js';
import { testDeps } from '../helpers/fakes.js';

it('authorizes monitoring by tenant, projects metadata and never renews or operates the browser', async () => {
    const deps = testDeps({ env: { STEEL_LOCAL: 'true' } });
    const status = {
        version: 1,
        epoch: randomUUID(),
        revision: 2,
        fill: { revision: 2, at: 1000, formId: 'login', submitted: true },
        secret: 'DO-NOT-EXPORT',
    };
    const read = vi.fn().mockResolvedValue(status);
    Object.assign(deps.api, { getBrowserMonitorStatus: read });
    const server = createSteelMcpServer(deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'monitor-test', version: '1' });
    await server.connect(st);
    await client.connect(ct);
    try {
        const result = await client.callTool({ name: 'browser_session_create', arguments: {} });
        const handle = (result.structuredContent as { session_id: string }).session_id;
        expect(handle).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
        const touch = vi.spyOn(deps.registry, 'touch');
        const page = vi.spyOn(deps.pool, 'page');
        const monitored = await client.callTool({ name: 'browser_session_monitor', arguments: { session_id: handle } });
        expect(monitored.isError).not.toBe(true);
        expect(monitored.structuredContent).toMatchObject({
            session_id: handle,
            monitor: { revision: 2, fill: { submitted: true } },
        });
        expect(JSON.stringify(monitored)).not.toContain('DO-NOT-EXPORT');
        expect(touch).not.toHaveBeenCalled();
        expect(page).not.toHaveBeenCalled();
        const denied = await client.callTool({
            name: 'browser_session_monitor',
            arguments: { session_id: 'missing-blue-otter' },
        });
        expect(denied.isError).toBe(true);
        expect(read).toHaveBeenCalledTimes(1);
    } finally {
        await client.close();
        await server.close();
    }
});
