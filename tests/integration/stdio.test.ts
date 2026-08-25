// ABOUTME: Integration tests that spawn the built stdio binary and drive it with a real MCP client,
// ABOUTME: covering the wire format, stderr logging discipline and startup failure behaviour.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMIT_POLICY, RATE_LIMIT_NAME, toolCost } from '../../src/core/rate-limit.js';

const BINARY = fileURLToPath(new URL('../../dist/stdio.js', import.meta.url));

let client: Client;
let stderr = '';

beforeAll(async () => {
    if (!existsSync(BINARY)) {
        throw new Error(`${BINARY} is missing. Run "npm run build" before the integration suite.`);
    }
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [BINARY],
        env: { ...process.env, STEEL_API_KEY: 'ste-integration-test', STEEL_PROFILE: 'browse' },
        stderr: 'pipe',
    });
    client = new Client({ name: 'stdio-integration', version: '1.0.0' });
    await client.connect(transport);
    transport.stderr?.on('data', chunk => {
        stderr += String(chunk);
    });
}, 30_000);

afterAll(async () => {
    await client?.close();
});

describe('the stdio binary', () => {
    it('serves tools/list over a real stdio connection', async () => {
        const { tools } = await client.listTools();
        expect(tools.map(tool => tool.name)).toContain('browser_scrape');
        expect(tools).toHaveLength(16);
    });

    it('advertises the server instructions', () => {
        expect(client.getInstructions()).toMatch(/browser_scrape/);
    });

    it('keeps stdout free of anything but JSON-RPC, logging to stderr instead', async () => {
        await client.listTools();
        await new Promise(resolve => setTimeout(resolve, 100));
        for (const line of stderr.split('\n').filter(Boolean)) {
            expect(() => JSON.parse(line) as unknown, `stderr line is not structured JSON: ${line}`).not.toThrow();
        }
        expect(stderr).toMatch(/steel-mcp listening on stdio/);
    });

    it('answers a stateful call with an unknown handle as a tool error, not a protocol error', async () => {
        const result = await client.callTool({
            name: 'browser_snapshot',
            arguments: { session_id: 'sess_does_not_exist' },
        });
        expect((result as { isError?: boolean }).isError).toBe(true);
    });

    it('rejects an argument that fails schema validation', async () => {
        const result = await client.callTool({ name: 'browser_scrape', arguments: { url: 'not a url' } });
        expect((result as { isError?: boolean }).isError).toBe(true);
    });

    it('applies no request budget, because one process serves one credential', async () => {
        // Far more calls than the hosted budget admits, so a limiter on this path would surface as a
        // rate_limited error instead of the unknown-handle error every one of these earns.
        const calls = Math.ceil((DEFAULT_RATE_LIMIT_POLICY.burstCapacity / toolCost('browser_snapshot')) * 3);
        for (let call = 0; call < calls; call++) {
            const result = (await client.callTool({
                name: 'browser_snapshot',
                arguments: { session_id: 'sess_does_not_exist' },
            })) as { isError?: boolean; content?: Array<{ text?: string }> };
            const text = result.content?.map(block => block.text ?? '').join('\n') ?? '';
            expect(result.isError).toBe(true);
            expect(text, `call ${call} was rate limited on the single-tenant stdio path`).not.toContain(
                RATE_LIMIT_NAME
            );
            expect(text).toMatch(/No live browser session/);
        }
    }, 20_000);
});

describe('shutdown', () => {
    it('tears down and exits when the host closes the pipe without signalling', async () => {
        const child = spawn(process.execPath, [BINARY], {
            env: { PATH: process.env.PATH ?? '', STEEL_API_KEY: 'ste-shutdown-test' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        child.stderr.on('data', chunk => {
            output += String(chunk);
        });
        await new Promise(resolve => setTimeout(resolve, 500));

        child.stdin.end();

        const code = await new Promise<number>(resolve => child.on('exit', resolve));
        expect(code).toBe(0);
        expect(output, 'the process exited without running the release path').toMatch(/shutting down/);
    }, 15_000);
});

describe('startup failure', () => {
    it('explains a missing API key on stderr and exits non-zero rather than hanging', async () => {
        const child = spawn(process.execPath, [BINARY], {
            env: { PATH: process.env.PATH ?? '', STEEL_API_KEY: '' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        child.stderr.on('data', chunk => {
            output += String(chunk);
        });
        const code = await new Promise<number>(resolve => child.on('exit', resolve));
        expect(code).toBe(1);
        expect(output).toMatch(/STEEL_API_KEY/);
    }, 15_000);
});
