// ABOUTME: Speaks JSON-RPC to the staged bundle's own dist/stdio.js against its pruned node_modules,
// ABOUTME: so a dependency the pack script removed too eagerly fails here rather than on a user's Mac.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { argv, exit, stderr as processStderr } from 'node:process';

const stage = argv[2];
if (!stage) {
    processStderr.write('usage: verify-mcpb-stage.mjs <staging-directory>\n');
    exit(2);
}

const EXPECTED_TOOL_COUNT = 16;
const TIMEOUT_MS = 20_000;

const child = spawn('node', [`${stage}/dist/stdio.js`], {
    cwd: stage,
    stdio: ['pipe', 'pipe', 'pipe'],
    // A key shaped like a real one, never sent anywhere: tools/list touches no Steel endpoint. The
    // profile arrives blank on purpose, the way a host substitutes an untouched optional config value.
    env: { PATH: process.env.PATH, STEEL_API_KEY: 'verify-only-not-a-real-key', STEEL_PROFILE: '' },
});

let stdout = '';
let stderrText = '';
const pending = new Map();

child.stdout.on('data', chunk => {
    stdout += chunk;
    let newline = stdout.indexOf('\n');
    while (newline !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf('\n');
        if (!line) continue;
        const message = JSON.parse(line);
        const resolve = pending.get(message.id);
        if (resolve) {
            pending.delete(message.id);
            resolve(message);
        }
    }
});
child.stderr.on('data', chunk => {
    stderrText += chunk;
});

function send(id, method, params) {
    const message = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    if (id !== undefined) message.id = id;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    if (id === undefined) return Promise.resolve();
    return new Promise(resolve => pending.set(id, resolve));
}

function fail(message) {
    child.kill();
    processStderr.write(`\nFAILED: ${message}\n`);
    if (stderrText.trim()) processStderr.write(`\nserver stderr:\n${stderrText}\n`);
    exit(1);
}

const timeout = setTimeout(() => fail(`the staged server did not answer within ${TIMEOUT_MS}ms`), TIMEOUT_MS);
child.on('exit', code => {
    if (pending.size > 0) fail(`the staged server exited with code ${code} before answering`);
});

const initialized = await send(1, 'initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'pack-verify', version: '1' },
});
if (initialized.error) fail(`initialize returned an error: ${JSON.stringify(initialized.error)}`);

await send(undefined, 'notifications/initialized');

const listed = await send(2, 'tools/list');
if (listed.error) fail(`tools/list returned an error: ${JSON.stringify(listed.error)}`);

const tools = listed.result?.tools ?? [];
if (tools.length !== EXPECTED_TOOL_COUNT) {
    fail(`expected ${EXPECTED_TOOL_COUNT} tools, the staged server listed ${tools.length}`);
}
const replay = tools.find(tool => tool.name === 'browser_session_replay');
if (!replay) fail('the staged server omitted browser_session_replay from the fifteen-tool contract');
if (replay._meta?.ui?.resourceUri) fail('dashboard-only replay unexpectedly declares an app resource');
if (!tools.some(tool => tool.name === 'browser_session_handoff')) fail('the staged server omitted session handoff');
const create = tools.find(tool => tool.name === 'browser_session_create');
if (!create) fail('the staged server omitted session create');
if (create.inputSchema?.properties?.region !== undefined) fail('session create still exposes infrastructure region');

const resources = await send(3, 'resources/list');
if (resources.error) fail(`resources/list returned an error: ${JSON.stringify(resources.error)}`);
const retiredReplayUri = 'ui://steel/session-replay';
if ((resources.result?.resources ?? []).some(resource => resource.uri === retiredReplayUri)) {
    fail('the staged server still lists the retired replay app resource');
}
const retiredRead = await send(4, 'resources/read', { uri: retiredReplayUri });
if (!retiredRead.error) fail('the staged server still serves the retired replay app resource');

for (const relative of ['dist/core/apps/session-replay.js', 'dist/vendor/hls.light.min.js']) {
    if (existsSync(`${stage}/${relative}`)) fail(`the staged bundle contains retired replay debris: ${relative}`);
}
const stagedFiles = readdirSync(stage, { recursive: true, encoding: 'utf8' });
const sourceMap = stagedFiles.find(relative => relative.endsWith('.map'));
if (sourceMap) fail(`the staged bundle contains a source map: ${sourceMap}`);

clearTimeout(timeout);
child.kill();

const version = initialized.result?.serverInfo?.version ?? 'unknown';
const startup = stderrText
    .split('\n')
    .filter(Boolean)
    .map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return undefined;
        }
    })
    .find(entry => entry?.message === 'steel-mcp listening on stdio');
if (startup?.server_version !== version) fail('the startup log and initialize versions disagree');
if (startup?.session_timeout_ms !== 900_000 || startup?.inactivity_timeout_ms !== 600_000) {
    fail('the staged server does not use the expected 15-minute hard and 10-minute idle defaults');
}
processStderr.write(
    `    staged server ${version} listed ${tools.length} tools with 900000ms hard and 600000ms idle defaults\n`
);
