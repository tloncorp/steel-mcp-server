// ABOUTME: Unit tests for the error mapping layer that turns Steel and CDP failures into
// ABOUTME: actionable tool-execution errors naming the cause and the next thing to try.
import { describe, expect, it } from 'vitest';
import {
    assessInteractiveBlock,
    botDetectionError,
    clickBlockedError,
    detectBotBlock,
    detectInteractiveBlock,
    type HandoffBlockEvidence,
    interactiveBlockError,
    mapSteelHttpError,
    nextMitigationRung,
    type PageControl,
    SteelToolError,
    selfHostUnsupportedError,
    staleRefError,
    toolErrorResult,
} from '../../src/core/errors.js';

describe('mapSteelHttpError', () => {
    it('translates 402 into the verified-balance requirement for managed proxies', () => {
        const err = mapSteelHttpError(
            402,
            { message: 'Payment required', error: 'payment_required' },
            {
                operation: 'session_create',
            }
        );
        expect(err.code).toBe('payment_required');
        expect(err.message).toMatch(/\$10 verified paid balance/);
        expect(err.message).toMatch(/free credits do not count/i);
        expect(err.message).toMatch(/use_proxy/);
    });

    it('names the concurrency cap when a 429 hits session creation', () => {
        const err = mapSteelHttpError(
            429,
            { message: 'Too many requests' },
            {
                operation: 'session_create',
                retryAfterSeconds: 12,
            }
        );
        expect(err.code).toBe('rate_limited');
        expect(err.message).toMatch(/concurrent session/i);
        expect(err.message).toMatch(/Retry after 12s/);
    });

    it('names the separate Browser Tools cap when a 429 hits a stateless read', () => {
        const err = mapSteelHttpError(429, { message: 'Too many requests' }, { operation: 'browser_tool' });
        expect(err.message).toMatch(/20 requests\/min Browser Tools/);
        expect(err.message).toMatch(/60 requests\/min/);
    });

    it('prefers the concurrency explanation when Steel says so in the body', () => {
        const err = mapSteelHttpError(
            429,
            { message: 'Concurrent session limit reached' },
            {
                operation: 'browser_tool',
            }
        );
        expect(err.message).toMatch(/concurrent session/i);
    });

    it('suppresses the 401 body claim that Steel does not accept bearer tokens', () => {
        const err = mapSteelHttpError(
            401,
            { message: "Unauthorized. Steel does not use 'Authorization: Bearer'", error: 'unauthorized' },
            { operation: 'browser_tool' }
        );
        expect(err.code).toBe('unauthorized');
        expect(err.message).not.toMatch(/does not use/i);
        expect(err.message).toMatch(/STEEL_API_KEY/);
    });

    it('passes Steel linkToDocs through verbatim', () => {
        const err = mapSteelHttpError(
            400,
            { message: 'Bad region', linkToDocs: 'https://docs.steel.dev/regions' },
            {
                operation: 'session_create',
            }
        );
        expect(err.linkToDocs).toBe('https://docs.steel.dev/regions');
        expect(toolErrorResult(err).content[0]).toMatchObject({
            type: 'text',
            text: expect.stringContaining('https://docs.steel.dev/regions'),
        });
    });

    it('explains a 407 as proxy configuration', () => {
        const err = mapSteelHttpError(407, { message: 'Proxy Authentication Required' }, { operation: 'navigate' });
        expect(err.code).toBe('proxy_failure');
        expect(err.message).toMatch(/proxy/i);
    });

    it('keeps Steel prose for statuses it has no special mapping for', () => {
        const err = mapSteelHttpError(418, { message: 'I am a teapot' }, { operation: 'navigate' });
        expect(err.code).toBe('steel_error');
        expect(err.message).toContain('I am a teapot');
    });
});

describe('detectBotBlock', () => {
    it('recognises a Cloudflare challenge from the interstitial body', () => {
        expect(detectBotBlock({ status: 403, body: '<title>Just a moment...</title>' })?.vendor).toBe('Cloudflare');
    });

    it('recognises Cloudflare from the __cf_bm cookie header', () => {
        expect(detectBotBlock({ status: 200, headers: { 'set-cookie': '__cf_bm=abc; Path=/' } })?.vendor).toBe(
            'Cloudflare'
        );
    });

    it('recognises DataDome, PerimeterX and Akamai markers', () => {
        expect(detectBotBlock({ status: 403, headers: { 'x-datadome': 'protected' } })?.vendor).toBe('DataDome');
        expect(detectBotBlock({ status: 403, body: 'window._pxAppId = "PX123"' })?.vendor).toBe('PerimeterX');
        expect(detectBotBlock({ status: 403, headers: { 'set-cookie': 'ak_bmsc=x' } })?.vendor).toBe('Akamai');
    });

    it("recognises Google's /sorry/ interstitial from the final URL", () => {
        expect(detectBotBlock({ status: 200, finalUrl: 'https://www.google.com/sorry/index?continue=x' })?.vendor).toBe(
            'Google'
        );
    });

    it('returns null for an ordinary page', () => {
        expect(detectBotBlock({ status: 200, body: '<h1>Welcome</h1>', finalUrl: 'https://example.com/' })).toBeNull();
    });
});

describe('detectInteractiveBlock', () => {
    it('reuses the vendor taxonomy so an interstitial is classified as a challenge, not a login', () => {
        const block = detectInteractiveBlock({
            finalUrl: 'https://shop.test/cart',
            title: 'Just a moment...',
            text: 'RootWebArea Just a moment...',
        });
        expect(block).toMatchObject({ kind: 'captcha', vendor: 'Cloudflare', marker: 'cf-chl' });
    });

    it('recognises the CAPTCHA widgets a person can clear in a live browser', () => {
        for (const [text, vendor] of [
            ["checkbox I'm not a robot", 'reCAPTCHA'],
            ['iframe hCaptcha challenge', 'hCaptcha'],
            ['Verify you are human', 'human-verification'],
        ] as const) {
            expect(detectInteractiveBlock({ finalUrl: 'https://x.test/', text })).toMatchObject({
                kind: 'captcha',
                vendor,
            });
        }
    });

    it('calls a page with a password field a login wall', () => {
        const block = detectInteractiveBlock({
            finalUrl: 'https://app.test/login',
            title: 'Sign in',
            text: 'textbox Email\ntextbox Password\nbutton Sign in',
            hasPasswordField: true,
        });
        expect(block).toMatchObject({ kind: 'login_wall', marker: 'password_field' });
    });

    it('does not call every page with a Sign in link a login wall', () => {
        // Nearly every page on the web has a "Sign in" link in its header. Without the password
        // field the detector would hand a human control of the browser on ordinary navigations.
        expect(
            detectInteractiveBlock({
                finalUrl: 'https://shop.test/products',
                title: 'Products',
                text: 'link Sign in\nheading Products\nbutton Add to basket',
            })
        ).toBeNull();
    });

    it('returns null for an ordinary page', () => {
        expect(
            detectInteractiveBlock({ finalUrl: 'https://example.com/', title: 'Example', text: 'heading Welcome' })
        ).toBeNull();
    });
});

/** A control as the snapshot pipeline classifies it, with the defaults a plain text run has. */
type FixtureControl = Partial<PageControl> & { role: string; name: string };

/**
 * Builds the evidence `mrtr` reads off a snapshot: the prose is the controls' own role and name,
 * exactly as the handoff assembles it, so a fixture cannot claim text no element accounts for.
 */
function pageEvidence(options: { url?: string; title?: string; controls: FixtureControl[] }): HandoffBlockEvidence {
    const controls: PageControl[] = options.controls.map(control => ({
        role: control.role,
        name: control.name,
        sensitive: control.sensitive ?? false,
        visible: control.visible ?? true,
        interactable: control.interactable ?? false,
    }));
    return {
        finalUrl: options.url ?? 'https://shop.test/',
        title: options.title ?? '',
        text: controls.map(control => `${control.role} ${control.name}`).join('\n'),
        hasPasswordField: controls.some(control => control.sensitive),
        controls,
    };
}

/** The furniture of a page that works: a nav, a basket and a long grid of products. */
function shopFurniture(): FixtureControl[] {
    return [
        { role: 'heading', name: 'Kitchen knives' },
        { role: 'link', name: 'Basket (2)', interactable: true },
        { role: 'searchbox', name: 'Search products', interactable: true },
        ...Array.from({ length: 24 }, (_unused, index) => ({
            role: 'link',
            name: `Santoku knife model ${index}`,
            interactable: true,
        })),
    ];
}

/** The one question the handoff decision asks: may a person be handed this drivable browser? */
function handsOff(evidence: HandoffBlockEvidence): boolean {
    return assessInteractiveBlock(evidence)?.clearableByPerson === true;
}

describe('assessInteractiveBlock', () => {
    it('hands off a challenge whose widget is on an otherwise empty page', () => {
        const verdict = assessInteractiveBlock(
            pageEvidence({
                url: 'https://shop.test/cart',
                title: 'Just a moment...',
                controls: [
                    { role: 'heading', name: 'Just a moment...' },
                    { role: 'Iframe', name: 'Widget containing a Cloudflare security challenge' },
                ],
            })
        );
        expect(verdict).toMatchObject({ block: { kind: 'captcha', vendor: 'Cloudflare' }, clearableByPerson: true });
    });

    it('hands off a login wall whose credential form a person could actually fill in', () => {
        const verdict = assessInteractiveBlock(
            pageEvidence({
                url: 'https://app.test/login',
                title: 'Sign in',
                controls: [
                    { role: 'textbox', name: 'Email', interactable: true },
                    { role: 'textbox', name: 'Password', sensitive: true, interactable: true },
                    { role: 'button', name: 'Sign in', interactable: true },
                ],
            })
        );
        expect(verdict).toMatchObject({ block: { kind: 'login_wall' }, clearableByPerson: true });
    });

    it('still calls a blank interstitial bot detection, with nothing for a person to operate', () => {
        // No widget rendered, so a person in the live browser would have no control to click. The
        // mitigation ladder is the answer here, and the error still says which vendor blocked it.
        const verdict = assessInteractiveBlock(
            pageEvidence({
                url: 'https://shop.test/cart',
                title: 'Just a moment...',
                controls: [
                    { role: 'heading', name: 'Just a moment...' },
                    { role: 'StaticText', name: 'Checking your browser before you continue' },
                ],
            })
        );
        expect(verdict).toMatchObject({ block: { vendor: 'Cloudflare' }, clearableByPerson: false });
    });

    it('leaves a page with no block at all alone', () => {
        expect(assessInteractiveBlock(pageEvidence({ controls: shopFurniture() }))).toBeNull();
    });
});

/**
 * Every measured false positive of the text taxonomy, asserted not to hand out a drivable browser.
 *
 * Each case also asserts the taxonomy verdict itself is unchanged: a marker in page prose is cheap
 * when it only picks the words of an error, and that job is `detectInteractiveBlock`'s to keep.
 */
describe('a text marker alone never hands a person the browser', () => {
    it('does not hand off an ordinary shop page carrying the reCAPTCHA v3 footer badge', () => {
        const evidence = pageEvidence({
            url: 'https://shop.test/products/santoku',
            title: 'Santoku knife — Shop',
            controls: [
                ...shopFurniture(),
                { role: 'Iframe', name: 'reCAPTCHA' },
                { role: 'StaticText', name: 'protected by reCAPTCHA' },
            ],
        });
        expect(detectInteractiveBlock(evidence)).toMatchObject({ kind: 'captcha', vendor: 'reCAPTCHA' });
        expect(handsOff(evidence)).toBe(false);
    });

    it('does not hand off a page whose own prose happens to say "just a moment"', () => {
        const evidence = pageEvidence({
            url: 'https://shop.test/orders',
            title: 'Your orders',
            controls: [...shopFurniture(), { role: 'status', name: 'Just a moment while we fetch your order history' }],
        });
        expect(detectInteractiveBlock(evidence)).toMatchObject({ kind: 'captcha', vendor: 'Cloudflare' });
        expect(handsOff(evidence)).toBe(false);
    });

    it("does not hand off a support page whose path contains Google's /sorry/ marker", () => {
        const evidence = pageEvidence({
            url: 'https://support.example.com/sorry/refunds',
            title: 'Sorry — refunds',
            controls: shopFurniture(),
        });
        expect(detectInteractiveBlock(evidence)).toMatchObject({ kind: 'captcha', vendor: 'Google' });
        expect(handsOff(evidence)).toBe(false);
    });

    it('does not hand off a page whose query string mentions a vendor', () => {
        const evidence = pageEvidence({
            url: 'https://evil.test/page?x=datadome',
            title: 'Read this',
            controls: [{ role: 'heading', name: 'Read this' }, ...shopFurniture()],
        });
        expect(detectInteractiveBlock(evidence)).toMatchObject({ kind: 'captcha', vendor: 'DataDome' });
        expect(handsOff(evidence)).toBe(false);
    });

    it('does not hand off a blog post about anti-bot vendors', () => {
        const evidence = pageEvidence({
            url: 'https://blog.test/comparing-datadome-and-perimeterx',
            title: 'Comparing DataDome and PerimeterX',
            controls: [
                { role: 'heading', name: 'Comparing DataDome and PerimeterX' },
                { role: 'paragraph', name: 'Both vendors fingerprint the browser before the page renders.' },
                { role: 'link', name: 'Subscribe', interactable: true },
            ],
        });
        expect(detectInteractiveBlock(evidence)).toMatchObject({ kind: 'captcha', vendor: 'DataDome' });
        expect(handsOff(evidence)).toBe(false);
    });

    it('does not hand off a page that only asks, in words, to verify you are human', () => {
        // Nothing to click, so there is nothing a person could do in the live browser either.
        const evidence = pageEvidence({
            url: 'https://evil.test/verify',
            title: 'Verify',
            controls: [{ role: 'StaticText', name: 'Please verify you are human to continue' }],
        });
        expect(detectInteractiveBlock(evidence)).toMatchObject({ kind: 'captcha', vendor: 'human-verification' });
        expect(handsOff(evidence)).toBe(false);
    });

    it('does not hand off a lone password box captioned with the words "Sign in"', () => {
        // The shape a hostile page fakes most cheaply: a credential field and a caption, with no
        // control that would submit anything.
        const evidence = pageEvidence({
            url: 'https://evil.test/page',
            title: 'Sign in',
            controls: [
                { role: 'StaticText', name: 'Sign in' },
                { role: 'textbox', name: 'Password', sensitive: true, interactable: true },
            ],
        });
        expect(detectInteractiveBlock(evidence)).toMatchObject({ kind: 'login_wall', marker: 'password_field' });
        expect(handsOff(evidence)).toBe(false);
    });
});

describe('interactiveBlockError', () => {
    it('routes a challenge to the bot-detection error, keeping the one-rung ladder', () => {
        const err = interactiveBlockError(
            { kind: 'captcha', vendor: 'DataDome', marker: 'datadome' },
            'https://shop.test/cart',
            {}
        );
        expect(err.code).toBe('bot_detection');
        expect(err.message).toBe(
            botDetectionError({ vendor: 'DataDome', marker: 'datadome' }, 'https://shop.test/cart', {}).message
        );
    });

    it('tells a login wall apart and points at the identity options, never at typing a password', () => {
        const err = interactiveBlockError(
            { kind: 'login_wall', vendor: 'credentials', marker: 'password_field' },
            'https://app.test/login',
            {}
        );
        expect(err.code).toBe('login_required');
        expect(err.message).toContain('https://app.test/login');
        expect(err.message).toMatch(/profile_id/);
        expect(err.message).toMatch(/namespace/);
        expect(err.message).toMatch(/never put a password in a tool argument/i);
    });

    it('says a loaded profile is not signed in and will not receive new login cookies', () => {
        const err = interactiveBlockError(
            { kind: 'login_wall', vendor: 'credentials', marker: 'password_field' },
            'https://app.test/login',
            { profileId: 'p1' }
        );
        expect(err.message).toMatch(/loaded a saved browser profile/i);
        expect(err.message).toMatch(/does not write new login cookies back/i);
    });
});

describe('nextMitigationRung', () => {
    it('starts at identity, never all rungs at once', () => {
        expect(nextMitigationRung({})).toMatchObject({ rung: 'identity' });
    });

    it('advances to pacing, then proxies, then captcha, then stealth', () => {
        expect(nextMitigationRung({ profileId: 'p1' }).rung).toBe('pacing');
        expect(nextMitigationRung({ profileId: 'p1', paced: true }).rung).toBe('proxies');
        expect(nextMitigationRung({ profileId: 'p1', paced: true, useProxy: true }).rung).toBe('captcha');
        const stealth = nextMitigationRung({
            profileId: 'p1',
            paced: true,
            useProxy: true,
            solveCaptcha: true,
        });
        expect(stealth.rung).toBe('stealth');
        expect(stealth.advice).not.toMatch(/\bregion\b/i);
    });
});

describe('botDetectionError', () => {
    it('says this is bot detection rather than a bug, and names exactly one next step', () => {
        const err = botDetectionError({ vendor: 'Cloudflare', marker: 'cf-chl' }, 'https://shop.test/cart', {});
        expect(err.code).toBe('bot_detection');
        expect(err.message).toMatch(/bot detection, not a bug/i);
        expect(err.message).toMatch(/Cloudflare/);
        expect(err.message).toMatch(/one thing at a time/i);
    });
});

describe('staleRefError', () => {
    it('names the ref, the snapshot it belongs to, the current snapshot and the recovery action', () => {
        const err = staleRefError('@e12', { refSnapshotId: 's3', currentSnapshotId: 's5', reason: 'page_navigated' });
        expect(err.code).toBe('stale_ref');
        expect(err.message).toContain('@e12');
        expect(err.message).toContain('s3');
        expect(err.message).toContain('s5');
        expect(err.message).toMatch(/page navigated/i);
        expect(err.message).toMatch(/browser_find|browser_snapshot/);
    });
});

describe('clickBlockedError', () => {
    it('names the blocker, bounds recovery and escalates a repeated failure', () => {
        const err = clickBlockedError('@e7', 'div#consent-banner');
        expect(err.code).toBe('click_blocked');
        expect(err.message).toContain('div#consent-banner');
        expect(err.message).toMatch(/dismiss_overlays/);
        expect(err.message).toMatch(/browser_find|browser_snapshot/);
        expect(err.message).toMatch(/retry once/i);
        expect(err.message).toMatch(/session_handoff.*repeating the same loop/i);

        const repeated = clickBlockedError('@e7', 'div#consent-banner', true);
        expect(repeated.message).toMatch(/still blocked after a recovery attempt/i);
        expect(repeated.message).toMatch(/do not retry/i);
        expect(repeated.message).toMatch(/another candidate|session_handoff/i);
        expect(repeated.details).toMatchObject({ handoff_required: true });
    });
});

describe('selfHostUnsupportedError', () => {
    it('gives the concurrency-1 rule its own named error', () => {
        const err = selfHostUnsupportedError('concurrency');
        expect(err.code).toBe('self_host_unsupported');
        expect(err.message).toMatch(/one browser session at a time/i);
        expect(err.message).toMatch(/browser_session_release/);
    });

    it('names each missing cloud capability instead of failing opaquely', () => {
        expect(selfHostUnsupportedError('use_proxy').message).toMatch(/Steel-managed prox/i);
        expect(selfHostUnsupportedError('solve_captcha').message).toMatch(/CAPTCHA solving/i);
        expect(selfHostUnsupportedError('profile_id').message).toMatch(/profile/i);
    });
});

describe('toolErrorResult', () => {
    it('produces an isError tool result with the message under an Error heading', () => {
        const result = toolErrorResult(new SteelToolError('boom', { code: 'steel_error' }));
        expect(result.isError).toBe(true);
        expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('### Error') });
        expect(result.structuredContent).toMatchObject({ error: { code: 'steel_error', message: 'boom' } });
    });

    it('wraps an unknown throwable without leaking a stack trace', () => {
        const result = toolErrorResult(new TypeError('undefined is not a function'));
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('undefined is not a function');
        expect(text).not.toContain('at Object.');
    });
});
