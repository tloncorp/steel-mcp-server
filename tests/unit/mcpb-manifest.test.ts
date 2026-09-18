// ABOUTME: Guards manifest.json, the file Claude Desktop reads to install this server as an MCPB
// ABOUTME: bundle, against drifting from the package it describes or the tools it actually registers.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolsForProfile } from '../../src/core/profiles.js';
import { SERVER_VERSION } from '../../src/core/version.js';

const root = new URL('../../', import.meta.url);
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, root)), 'utf8');

interface McpbManifest {
    manifest_version: string;
    name: string;
    display_name?: string;
    version: string;
    description: string;
    long_description?: string;
    author: { name: string; email?: string; url?: string };
    homepage?: string;
    documentation?: string;
    support?: string;
    icon?: string;
    license?: string;
    keywords?: string[];
    privacy_policies?: string[];
    repository?: { type: string; url: string };
    server: {
        type: string;
        entry_point: string;
        mcp_config: { command: string; args?: string[]; env?: Record<string, string> };
    };
    tools?: Array<{ name: string; description?: string }>;
    tools_generated?: boolean;
    user_config?: Record<
        string,
        { type: string; title: string; description: string; required?: boolean; sensitive?: boolean; default?: unknown }
    >;
    compatibility?: { platforms?: string[]; runtimes?: { node?: string } };
}

const bundle = JSON.parse(read('manifest.json')) as McpbManifest;
const pkg = JSON.parse(read('package.json')) as {
    version: string;
    license: string;
    description: string;
    engines: { node: string };
    repository: { url: string };
};

describe('the MCPB bundle manifest', () => {
    it('declares the manifest version the current mcpb toolchain validates against', () => {
        expect(bundle.manifest_version).toBe('0.4');
    });

    it('reports the same version as the package and the wire', () => {
        expect(bundle.version).toBe(pkg.version);
        expect(bundle.version).toBe(SERVER_VERSION);
    });

    it('is MIT licensed, which the directory requires', () => {
        expect(bundle.license).toBe('MIT');
        expect(bundle.license).toBe(pkg.license);
    });

    it('names an author reachable on GitHub, as the submission form requires', () => {
        expect(bundle.author.name).toBeTruthy();
        expect(bundle.author.url).toMatch(/^https:\/\/github\.com\/[\w-]+$/);
        expect(bundle.author.email).toContain('@');
    });

    it('links a privacy policy, whose absence is an immediate rejection', () => {
        expect(bundle.privacy_policies?.length).toBeGreaterThan(0);
        for (const url of bundle.privacy_policies ?? []) expect(url).toMatch(/^https:\/\//);
    });

    it('links the same privacy policy the README does', () => {
        // Review reads both. Two URLs that disagree is worse than one, and this is the pair most
        // likely to drift, since the policy lives on a site this repository does not control.
        const readme = read('README.md');
        for (const url of bundle.privacy_policies ?? []) {
            expect(readme, `the README never links ${url}`).toContain(url);
        }
    });

    it('points support and documentation somewhere a user can actually reach', () => {
        expect(bundle.support).toMatch(/^https:\/\//);
        expect(bundle.documentation).toMatch(/^https:\/\//);
        expect(bundle.repository?.url).toContain('steel-dev/steel-mcp-server');
    });
});

describe('the manifest launch configuration', () => {
    it('launches the built stdio entrypoint through Node', () => {
        expect(bundle.server.type).toBe('node');
        expect(bundle.server.entry_point).toBe('dist/stdio.js');
        expect(bundle.server.mcp_config.command).toBe('node');
    });

    it('resolves the entrypoint relative to the installed bundle rather than a developer checkout', () => {
        // An absolute path baked at author time points at a directory that does not exist on the
        // user's machine. ${__dirname} is what the host substitutes for the unpacked location.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: an MCPB host placeholder, expanded at install time rather than by JS
        expect(bundle.server.mcp_config.args).toEqual(['${__dirname}/dist/stdio.js']);
    });

    it('takes the API key from user config, so Desktop prompts instead of shipping a placeholder', () => {
        const key = bundle.user_config?.steel_api_key;
        expect(key?.type).toBe('string');
        expect(key?.required).toBe(true);
        expect(key?.sensitive, 'the API key would be stored and displayed in the clear').toBe(true);
        // biome-ignore lint/suspicious/noTemplateCurlyInString: an MCPB host placeholder, expanded at install time rather than by JS
        expect(bundle.server.mcp_config.env?.STEEL_API_KEY).toBe('${user_config.steel_api_key}');
    });

    it('never hardcodes a credential in the manifest', () => {
        expect(read('manifest.json')).not.toMatch(/ste-[A-Za-z0-9]/);
    });

    it('declares the runtime the package requires', () => {
        expect(bundle.compatibility?.runtimes?.node).toBe(pkg.engines.node);
    });

    it('declares the platforms Claude for desktop runs on', () => {
        expect(bundle.compatibility?.platforms).toEqual(['darwin', 'win32']);
    });

    it('ships the icon it names', () => {
        expect(bundle.icon).toBeTruthy();
        expect(existsSync(fileURLToPath(new URL(bundle.icon as string, root)))).toBe(true);
    });
});

describe('the pack script', () => {
    const script = read('scripts/pack-mcpb.sh');

    it('stages every path the manifest and the launch config name', () => {
        for (const path of ['dist', 'manifest.json', 'LICENSE']) {
            expect(script, `the staging tree never copies ${path}`).toContain(path);
        }
    });

    it('stages the icon the manifest names rather than all of assets/', () => {
        // assets/ holds demo recordings — 75MB the bundle has no use for and every user would pay to
        // download. Reading the path from the manifest is also what keeps the two from drifting.
        expect(script).not.toMatch(/cp -R "\$ROOT\/assets"/);
        expect(script).toContain("require('$ROOT/manifest.json').icon");
    });

    it('installs without dev or optional dependencies', () => {
        expect(script).toContain('--omit=dev');
        expect(script).toContain('--omit=optional');
    });

    it('narrows the staged package.json before installing, rather than deleting trees afterwards', () => {
        // Deleting an installed directory leaves its dependencies behind: removing ioredis that way
        // still ships redis-parser, denque and four more. Narrowing first means npm never fetches them.
        expect(script).toContain('stage-mcpb-package.mjs');
        expect(script.indexOf('stage-mcpb-package.mjs')).toBeLessThan(script.indexOf('npm --prefix "$STAGE" install'));
    });

    it('keeps exactly the runtime dependencies the entrypoint reaches', () => {
        // The same set packaging.test.ts derives by walking the import graph from stdio.ts. If that
        // test's list changes and this one does not, the bundle is missing a package or carrying dead weight.
        const staging = read('scripts/stage-mcpb-package.mjs');
        const declared = /const RUNTIME_DEPENDENCIES = \[([^\]]+)\]/.exec(staging)?.[1] ?? '';
        expect([...declared.matchAll(/'([^']+)'/g)].map(match => match[1])).toEqual([
            '@modelcontextprotocol/server',
            '@opentelemetry/api',
            'safe-regex2',
            'ws',
            'zod',
        ]);
    });

    it('proves the staged server runs before packing it', () => {
        expect(script).toContain('verify-mcpb-stage.mjs');
        expect(script.indexOf('verify-mcpb-stage.mjs')).toBeLessThan(script.indexOf('$MCPB pack'));
    });

    it('validates the staged manifest rather than only the source one', () => {
        expect(script).toContain('validate "$STAGE/manifest.json"');
    });

    it('runs in CI, so a bundle that stops building fails a pull request', () => {
        expect(read('.github/workflows/ci.yml')).toContain('npm run pack:mcpb');
    });
});

describe('the manifest tool list', () => {
    it('lists exactly the default tools without optional inference credentials, in the same order', () => {
        expect(bundle.tools?.map(tool => tool.name)).toEqual(toolsForProfile('browse').map(tool => tool.name));
    });

    it('describes every tool it lists', () => {
        for (const tool of bundle.tools ?? []) {
            expect(tool.description, `${tool.name} has no description`).toBeTruthy();
        }
    });

    it('does not claim the list was generated by a host', () => {
        // tools_generated true tells a host these were discovered rather than authored, which would
        // excuse the list from matching. It is authored here, and tested against TOOL_TABLE.
        expect(bundle.tools_generated ?? false).toBe(false);
    });
});
