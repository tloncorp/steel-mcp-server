// ABOUTME: Unit tests for the Redis client adapter: each registry command maps to the right client
// ABOUTME: call, including the millisecond expiry, and a connection error is reported, never thrown.
import { describe, expect, it } from 'vitest';
import { redisConnection } from '../../src/core/redis.js';
import { RecordingRedisClient } from '../helpers/fake-redis.js';

function connection(client: RecordingRedisClient, onError: (error: unknown) => void = () => {}) {
    return redisConnection(client, onError);
}

describe('redisConnection commands', () => {
    it('sets a value with a millisecond expiry, the only TTL unit the registry uses', async () => {
        const client = new RecordingRedisClient();
        await connection(client).commands.set('steel-mcp:handle:calm-blue-fox', '{}', 90_000);

        expect(client.calls).toEqual([
            { command: 'set', args: ['steel-mcp:handle:calm-blue-fox', '{}', 'PX', 90_000] },
        ]);
    });

    it('passes reads, deletes and set membership straight through', async () => {
        const client = new RecordingRedisClient({
            get: '{"handle":"calm-blue-fox"}',
            del: 1,
            smembers: ['calm-blue-fox'],
        });
        const commands = connection(client).commands;

        expect(await commands.get('key')).toBe('{"handle":"calm-blue-fox"}');
        expect(await commands.del('key')).toBe(1);
        expect(await commands.smembers('index')).toEqual(['calm-blue-fox']);
        await commands.sadd('index', 'calm-blue-fox');
        await commands.srem('index', 'calm-blue-fox');

        expect(client.calls.map(call => call.command)).toEqual(['get', 'del', 'smembers', 'sadd', 'srem']);
        expect(client.calls.at(-1)?.args).toEqual(['index', 'calm-blue-fox']);
    });

    it('reports how many keys a delete removed, which is what settles a concurrent sweep', async () => {
        expect(await connection(new RecordingRedisClient({ del: 0 })).commands.del('gone')).toBe(0);
    });

    it('increments a counter and expires it in milliseconds, as two commands', async () => {
        // INCR creates its key with no expiry, so the TTL cannot ride along with the increment.
        const client = new RecordingRedisClient({ incr: 2 });
        const commands = connection(client).commands;

        expect(await commands.incr('steel-mcp:handle:calm-blue-fox:rounds')).toBe(2);
        await commands.pexpire('steel-mcp:handle:calm-blue-fox:rounds', 90_000);

        expect(client.calls).toEqual([
            { command: 'incr', args: ['steel-mcp:handle:calm-blue-fox:rounds'] },
            { command: 'pexpire', args: ['steel-mcp:handle:calm-blue-fox:rounds', 90_000] },
        ]);
    });

    it('maps lease claims and fenced updates to atomic Redis operations', async () => {
        const client = new RecordingRedisClient();
        const commands = connection(client).commands;

        expect(await commands.setIfAbsent('control', 'lease-1', 60_000)).toBe(true);
        expect(await commands.compareSet('control', 'lease-1', 'lease-2', 60_000)).toBe(true);
        expect(await commands.compareDelete('control', 'lease-2')).toBe(true);

        expect(client.calls[0]).toEqual({ command: 'set', args: ['control', 'lease-1', 'PX', 60_000, 'NX'] });
        expect(client.calls.slice(1).map(call => call.command)).toEqual(['eval', 'eval']);
        expect(client.calls[1]?.args).toContain('lease-1');
        expect(client.calls[2]?.args).toContain('lease-2');
    });
});

describe('redisConnection lifecycle', () => {
    it('reports a client error instead of letting it take the replica down', () => {
        // An ioredis client with no error listener turns a reconnect into an uncaught exception.
        const failures: unknown[] = [];
        const client = new RecordingRedisClient();
        connection(client, error => failures.push(error));

        client.emitError(new Error('ECONNREFUSED'));

        expect(failures.map(String)).toEqual(['Error: ECONNREFUSED']);
    });

    it('quits the client on close, so a shutting-down replica frees its connection', async () => {
        const client = new RecordingRedisClient();
        await connection(client).close();

        expect(client.calls.map(call => call.command)).toEqual(['quit']);
    });
});
