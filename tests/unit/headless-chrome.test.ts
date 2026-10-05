// ABOUTME: Exercises the launch observations that turn a silent Chrome startup failure into an
// ABOUTME: exact missing, malformed, unreadable or exited diagnostic instead of a generic timeout.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeadlessChrome, type LaunchWatch, readDebuggerUrl, terminateProcess } from '../helpers/headless-chrome.js';

const profiles: string[] = [];

function profile(): string {
    const directory = mkdtempSync(join(tmpdir(), 'steel-viewer-launch-test-'));
    profiles.push(directory);
    return directory;
}

function watch(overrides: Partial<LaunchWatch> = {}): LaunchWatch {
    return {
        ending: () => undefined,
        status: () => 'Process status: pid=123, exitCode=null, signalCode=null, killed=false',
        stderr: () => '',
        ...overrides,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true });
});

describe('Chrome launch observations', () => {
    it('returns a validated debugger endpoint and the time spent waiting', async () => {
        const directory = profile();
        writeFileSync(join(directory, 'DevToolsActivePort'), '43210\n/devtools/browser/browser-id\n');

        const endpoint = await readDebuggerUrl(directory, 50, watch());

        expect(endpoint.url).toBe('ws://127.0.0.1:43210/devtools/browser/browser-id');
        expect(endpoint.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('says when the port file is absent and includes process, profile and stderr state', async () => {
        const directory = profile();

        await expect(readDebuggerUrl(directory, 0, watch())).rejects.toThrow(
            /DevToolsActivePort was absent.*Process status: pid=123.*Chrome profile was empty.*No Chrome stderr had been captured/
        );
    });

    it('reports an existing malformed port file rather than calling it absent', async () => {
        const directory = profile();
        writeFileSync(join(directory, 'DevToolsActivePort'), 'not-a-port\n/devtools/browser/browser-id\n');

        await expect(readDebuggerUrl(directory, 0, watch())).rejects.toThrow(
            /DevToolsActivePort existed but was malformed: "not-a-port\\n\/devtools\/browser\/browser-id\\n"/
        );
    });

    it('reports a read error separately from a missing file', async () => {
        const directory = profile();
        mkdirSync(join(directory, 'DevToolsActivePort'));

        await expect(readDebuggerUrl(directory, 0, watch())).rejects.toThrow(/DevToolsActivePort could not be read:/);
    });

    it('checks process ending again after its final poll instead of misreporting a timeout', async () => {
        const directory = profile();
        let observations = 0;
        vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1);

        await expect(
            readDebuggerUrl(
                directory,
                1,
                watch({ ending: () => (++observations === 1 ? undefined : 'exited with code 23') })
            )
        ).rejects.toThrow(/Chrome exited with code 23 .* before it started listening/);
    });
});

describe('Chrome process cleanup', () => {
    it('preserves the launch diagnostic when the child exits before publishing a port', async () => {
        await expect(HeadlessChrome.launch(process.execPath)).rejects.toThrow(
            /Chrome exited with code \d+ .* before it started listening.*Chrome stderr:.*--headless=new/s
        );
    });

    it('does not return until the spawned process has exited', async () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

        await terminateProcess(child);

        expect(child.signalCode).toBe('SIGKILL');
    });
});
