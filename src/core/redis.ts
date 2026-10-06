// ABOUTME: The Redis client adapter: maps the handle registry's commands onto ioredis and reports
// ABOUTME: connection failures to the caller instead of letting an unheard error event end the replica.
import { Redis } from 'ioredis';
import type { RedisCommands } from './registry-redis.js';

/**
 * The slice of an ioredis client this adapter uses.
 *
 * Narrow on purpose: the command mapping, including the millisecond expiry, is then testable
 * against a recording double instead of a server.
 */
export interface RedisClient {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
    set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<unknown>;
    eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
    del(key: string): Promise<number>;
    incr(key: string): Promise<number>;
    pexpire(key: string, ttlMs: number): Promise<number>;
    sadd(key: string, member: string): Promise<number>;
    srem(key: string, member: string): Promise<number>;
    smembers(key: string): Promise<string[]>;
    quit(): Promise<unknown>;
    on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface RedisConnection {
    commands: RedisCommands;
    close(): Promise<void>;
}

/**
 * Wraps a client as a registry command interface and attaches the error reporter.
 *
 * The listener is not optional politeness: a Redis client emits `error` on every failed reconnect,
 * and an `error` event with no listener is an uncaught exception that takes the replica with it.
 */
export function redisConnection(client: RedisClient, onError: (error: unknown) => void): RedisConnection {
    client.on('error', onError);

    const commands: RedisCommands = {
        claimHandle: async (keys, value, ttlMs) =>
            (await client.eval(
                `if not redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 0 end
                redis.call('DEL', KEYS[2], KEYS[3], KEYS[4], KEYS[5])
                redis.call('SADD', KEYS[6], ARGV[3])
                redis.call('SADD', KEYS[7], ARGV[4])
                return 1`,
                7,
                keys.record,
                ...keys.fields,
                keys.principalIndex,
                keys.liveIndex,
                value,
                ttlMs,
                keys.handle,
                keys.member
            )) === 1,
        forgetHandle: async (keys, expected, removeRecord) =>
            (await client.eval(
                `local current = redis.call('GET', KEYS[1])
                if ARGV[1] == '1' then
                    if current then return 0 end
                elseif current ~= ARGV[2] then return 0 end
                local removed = 0
                if ARGV[3] == '1' then
                    if current then removed = 1 end
                    redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5])
                end
                redis.call('SREM', KEYS[6], ARGV[4])
                redis.call('SREM', KEYS[7], ARGV[5])
                return removed`,
                7,
                keys.record,
                ...keys.fields,
                keys.principalIndex,
                keys.liveIndex,
                expected === null ? '1' : '0',
                expected ?? '',
                removeRecord ? '1' : '0',
                keys.handle,
                keys.member
            )) === 1,
        get: key => client.get(key),
        set: async (key, value, ttlMs) => {
            await client.set(key, value, 'PX', ttlMs);
        },
        setIfAbsent: async (key, value, ttlMs) => (await client.set(key, value, 'PX', ttlMs, 'NX')) === 'OK',
        compareSet: async (key, expected, value, ttlMs) =>
            (await client.eval(
                "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1 else return 0 end",
                1,
                key,
                expected,
                value,
                ttlMs
            )) === 1,
        compareDelete: async (key, expected) =>
            (await client.eval(
                "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
                1,
                key,
                expected
            )) === 1,
        del: key => client.del(key),
        incr: key => client.incr(key),
        pexpire: async (key, ttlMs) => {
            await client.pexpire(key, ttlMs);
        },
        sadd: async (key, member) => {
            await client.sadd(key, member);
        },
        srem: async (key, member) => {
            await client.srem(key, member);
        },
        smembers: key => client.smembers(key),
    };

    return {
        commands,
        close: async () => {
            await client.quit();
        },
    };
}

/** Connects to Redis over a `redis://` or `rediss://` URL, reporting every client error to `onError`. */
export function connectRedis(url: string, onError: (error: unknown) => void): RedisConnection {
    return redisConnection(new Redis(url), onError);
}
