// ABOUTME: Unit tests for the human-in-the-loop handoff: the signed requestState it round-trips,
// ABOUTME: the client-capability gate that decides whether it may be offered, and the viewer URL.
import type { ServerContext } from '@modelcontextprotocol/server';
import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
    createHandoffCodec,
    type HandoffState,
    handoffOrigin,
    handoffViewerUrl,
    supportsElicitation,
    supportsInlineViewer,
    supportsUrlElicitation,
} from '../../src/core/mrtr.js';
import { UI_EXTENSION_NAME } from '../../src/core/server.js';

const SECRET = 'k'.repeat(48);

/** The smallest slice of the server context the handoff reads, shaped as the SDK hands it over. */
function context(options: { capabilities?: Record<string, unknown>; method?: string; clientId?: string } = {}) {
    return {
        mcpReq: {
            method: options.method ?? 'tools/call',
            ...(options.capabilities === undefined
                ? {}
                : { envelope: { [CLIENT_CAPABILITIES_META_KEY]: options.capabilities } }),
        },
        ...(options.clientId === undefined ? {} : { http: { authInfo: { clientId: options.clientId } } }),
    } as unknown as ServerContext;
}

const STATE: HandoffState = {
    handle: 'sess_abc',
    tool: 'browser_navigate',
    block: 'login_wall',
    origin: 'https://app.test',
    round: 1,
};

describe('createHandoffCodec', () => {
    it('round-trips the state a retry needs and nothing a client could not already see', async () => {
        const codec = createHandoffCodec(SECRET);
        const ctx = context({ clientId: 'principal-a' });
        expect(await codec.verify(await codec.mint(STATE, ctx), ctx)).toEqual(STATE);
    });

    it('rejects state whose body was edited, so a client cannot promote its own round count', async () => {
        const codec = createHandoffCodec(SECRET);
        const ctx = context({ clientId: 'principal-a' });
        const sealed = await codec.mint(STATE, ctx);
        const [version, body, mac] = sealed.split('.');
        const edited = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'));
        edited.p.handle = 'sess_someoneelse';
        const forged = [version, Buffer.from(JSON.stringify(edited)).toString('base64url'), mac].join('.');

        await expect(codec.verify(forged, ctx)).rejects.toThrow(/mac/);
    });

    it('rejects state echoed by a different principal', async () => {
        const codec = createHandoffCodec(SECRET);
        const sealed = await codec.mint(STATE, context({ clientId: 'principal-a' }));
        await expect(codec.verify(sealed, context({ clientId: 'principal-b' }))).rejects.toThrow(/bind/);
    });

    it('rejects state echoed on a different method', async () => {
        const codec = createHandoffCodec(SECRET);
        const sealed = await codec.mint(STATE, context({ method: 'tools/call' }));
        await expect(codec.verify(sealed, context({ method: 'resources/read' }))).rejects.toThrow(/bind/);
    });

    it('rejects state minted under a different secret', async () => {
        const sealed = await createHandoffCodec(SECRET).mint(STATE, context());
        await expect(createHandoffCodec('j'.repeat(48)).verify(sealed, context())).rejects.toThrow(/mac/);
    });

    it('never embeds the principal in the wire value the client holds', async () => {
        const codec = createHandoffCodec(SECRET);
        const sealed = await codec.mint(STATE, context({ clientId: 'principal-a' }));
        expect(sealed).not.toContain('principal-a');
    });
});

describe('supportsUrlElicitation', () => {
    it('is true only when the request declares the url elicitation mode', () => {
        expect(supportsUrlElicitation(context({ capabilities: { elicitation: { url: {} } } }))).toBe(true);
    });

    it('is false for a client that declared form elicitation only', () => {
        expect(supportsUrlElicitation(context({ capabilities: { elicitation: { form: {} } } }))).toBe(false);
    });

    it('is false for a bare elicitation declaration, which means form on the 2025 reading', () => {
        expect(supportsUrlElicitation(context({ capabilities: { elicitation: {} } }))).toBe(false);
    });

    it('is false when the request declared no capabilities at all', () => {
        expect(supportsUrlElicitation(context({ capabilities: {} }))).toBe(false);
        expect(supportsUrlElicitation(context())).toBe(false);
    });

    it('falls back to the capabilities an older connection declared at initialize', () => {
        const declared = { elicitation: { url: {} } };
        expect(supportsUrlElicitation(context(), () => declared)).toBe(true);
        expect(supportsUrlElicitation(context(), () => undefined)).toBe(false);
    });
});

describe('supportsInlineViewer', () => {
    it('is true when the request declares the MCP-Apps UI extension', () => {
        expect(supportsInlineViewer(context({ capabilities: { extensions: { [UI_EXTENSION_NAME]: {} } } }))).toBe(true);
    });

    it('is false when the request declared extensions but not this one', () => {
        expect(supportsInlineViewer(context({ capabilities: { extensions: { 'some/other': {} } } }))).toBe(false);
    });

    it('is false when the request declared no extensions at all', () => {
        expect(supportsInlineViewer(context({ capabilities: { elicitation: { url: {} } } }))).toBe(false);
        expect(supportsInlineViewer(context({ capabilities: {} }))).toBe(false);
    });

    it('has no initialize-era fallback: a request with no per-request envelope never takes the inline path', () => {
        // A session may separately remember that its create call rendered a viewer; this helper
        // remains a strict reader of the current request envelope.
        expect(supportsInlineViewer(context())).toBe(false);
    });
});

describe('supportsElicitation', () => {
    it('is true for form elicitation (a bare object) as well as URL elicitation', () => {
        expect(supportsElicitation(context({ capabilities: { elicitation: {} } }))).toBe(true);
        expect(supportsElicitation(context({ capabilities: { elicitation: { url: {} } } }))).toBe(true);
    });

    it('is false when no elicitation was declared, even if other capabilities were', () => {
        expect(supportsElicitation(context({ capabilities: { extensions: { [UI_EXTENSION_NAME]: {} } } }))).toBe(false);
        expect(supportsElicitation(context({ capabilities: {} }))).toBe(false);
        expect(supportsElicitation(context())).toBe(false);
    });
});

describe('handoffViewerUrl', () => {
    it('passes a plain player URL through', () => {
        expect(handoffViewerUrl('https://api.steel.dev/v1/sessions/abc/player')).toBe(
            'https://api.steel.dev/v1/sessions/abc/player'
        );
    });

    it('strips any credential a deployment put in the query before the URL leaves the server', () => {
        const url = handoffViewerUrl(
            'https://api.steel.dev/v1/sessions/abc/player?apiKey=ste-secret&token=t&access_token=a&hideOverlay=true'
        );
        expect(url).not.toContain('ste-secret');
        expect(url).not.toContain('token');
        expect(url).toContain('hideOverlay=true');
    });

    it('keeps only the parameters the player itself reads, whatever a credential is named', () => {
        // Every one of these survived a denylist that matched exact lower-camel names.
        const url = handoffViewerUrl(
            'https://api.steel.dev/v1/sessions/abc/player?APIKEY=a&ApiKey=b&Authorization=c&steel-api-key=d' +
                '&session_token=e&secret=f&password=g&sig=h&signature=i&jwt=j' +
                '&hideOverlay=true&hideInteractionDialog=true'
        );
        expect(url).toBe('https://api.steel.dev/v1/sessions/abc/player?hideOverlay=true&hideInteractionDialog=true');
    });

    it('clears the fragment, which never reaches a server and is where a token hides', () => {
        expect(handoffViewerUrl('https://api.steel.dev/v1/sessions/abc/player#apiKey=ste-secret')).toBe(
            'https://api.steel.dev/v1/sessions/abc/player'
        );
    });

    it('refuses userinfo rather than quietly changing which host a person is asked to trust', () => {
        expect(handoffViewerUrl('https://ste-secret@api.steel.dev/v1/sessions/abc/player')).toBeUndefined();
        expect(handoffViewerUrl('https://user:ste-secret@api.steel.dev/v1/sessions/abc/player')).toBeUndefined();
    });

    it('refuses a non-http URL rather than handing a person something unopenable', () => {
        expect(handoffViewerUrl('javascript:alert(1)')).toBeUndefined();
        expect(handoffViewerUrl('not a url')).toBeUndefined();
        expect(handoffViewerUrl(undefined)).toBeUndefined();
    });
});

describe('handoffOrigin', () => {
    it('names the origin and drops the attacker-written prose a path can carry', () => {
        expect(handoffOrigin('https://evil.test/Your-session-expired-sign-in-again-at-evil-test?u=x#y')).toBe(
            'https://evil.test'
        );
    });

    it('keeps the port, which is part of which server a person is being told about', () => {
        expect(handoffOrigin('http://localhost:3000/login')).toBe('http://localhost:3000');
    });

    it('names nothing rather than something a person cannot check', () => {
        expect(handoffOrigin('about:blank')).toBeUndefined();
        expect(handoffOrigin('data:text/html,<h1>Sign in</h1>')).toBeUndefined();
        expect(handoffOrigin('not a url')).toBeUndefined();
        expect(handoffOrigin(`https://${'a'.repeat(300)}.test/login`)).toBeUndefined();
    });

    it('leaves no invisible character in what a person reads', () => {
        expect(handoffOrigin('https://evil.test/​sign-in')).toBe('https://evil.test');
    });
});

// The server-side round count now lives on the handle record. Its own behaviour is covered for both
// registry backends in registry-conformance.test.ts, and the bound it enforces end to end — a client
// that never echoes the signed state back — in integration/mrtr.test.ts.
