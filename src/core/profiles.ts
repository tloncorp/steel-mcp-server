// ABOUTME: Named tool presets and the single ordered tool table, so tools/list is deterministic
// ABOUTME: and a profile selection is a data change rather than a code change.
import type { ProfileName } from './config.js';
import type { ServerDeps, ToolHost } from './context.js';
import { registerBatch } from './tools/batch.js';
import { registerAct, registerFind, registerNavigate, registerSnapshot, registerWaitFor } from './tools/browse.js';
import { registerSessionHandoff } from './tools/handoff.js';
import { registerSessionReplay } from './tools/replay.js';
import {
    registerSessionCreate,
    registerSessionDiagnostics,
    registerSessionLiveView,
    registerSessionRelease,
} from './tools/session.js';
import { registerSessionOptions } from './tools/session-options.js';
import { registerPdf, registerScrape, registerScreenshot } from './tools/stateless.js';

export interface ToolDefinition {
    name: string;
    /** Profiles this tool belongs to. */
    profiles: ProfileName[];
    register(host: ToolHost, deps: ServerDeps): void;
}

const SCRAPE_AND_UP: ProfileName[] = ['scrape', 'browse'];
const BROWSE_AND_UP: ProfileName[] = ['browse'];

/**
 * The tool table, in the order `tools/list` returns them.
 *
 * The order is fixed here rather than derived from a map, because a stable ordering is what makes
 * a host's prompt cache hit across connections.
 */
export const TOOL_TABLE: ToolDefinition[] = [
    { name: 'browser_scrape', profiles: SCRAPE_AND_UP, register: registerScrape },
    { name: 'browser_screenshot', profiles: SCRAPE_AND_UP, register: registerScreenshot },
    { name: 'browser_pdf', profiles: SCRAPE_AND_UP, register: registerPdf },
    { name: 'browser_session_create', profiles: BROWSE_AND_UP, register: registerSessionCreate },
    { name: 'browser_session_release', profiles: BROWSE_AND_UP, register: registerSessionRelease },
    { name: 'browser_navigate', profiles: BROWSE_AND_UP, register: registerNavigate },
    { name: 'browser_snapshot', profiles: BROWSE_AND_UP, register: registerSnapshot },
    { name: 'browser_find', profiles: BROWSE_AND_UP, register: registerFind },
    { name: 'browser_act', profiles: BROWSE_AND_UP, register: registerAct },
    { name: 'browser_wait_for', profiles: BROWSE_AND_UP, register: registerWaitFor },
    { name: 'browser_session_diagnostics', profiles: BROWSE_AND_UP, register: registerSessionDiagnostics },
    { name: 'browser_session_handoff', profiles: BROWSE_AND_UP, register: registerSessionHandoff },
    { name: 'browser_session_replay', profiles: BROWSE_AND_UP, register: registerSessionReplay },
    { name: 'browser_batch', profiles: BROWSE_AND_UP, register: registerBatch },
    { name: 'browser_session_options', profiles: BROWSE_AND_UP, register: registerSessionOptions },
    // Last on purpose. A host filters this one out of the list it shows the model, and appending
    // rather than inserting keeps the prefix every other tool sits in byte-identical.
    { name: 'browser_session_live_view', profiles: BROWSE_AND_UP, register: registerSessionLiveView },
];

/** The tools a profile exposes, in `tools/list` order. */
export function toolsForProfile(profile: ProfileName): ToolDefinition[] {
    return TOOL_TABLE.filter(tool => tool.profiles.includes(profile));
}
