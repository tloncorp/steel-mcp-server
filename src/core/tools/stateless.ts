// ABOUTME: The three stateless read tools — scrape, screenshot and pdf — which start no browser
// ABOUTME: session, so they carry no billing surprise and no way to leak one.
import type { ContentBlock } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { PublishedArtifact } from '../artifacts.js';
import type { ServerDeps, ToolHost } from '../context.js';
import { botDetectionError, detectBotBlock, SteelToolError } from '../errors.js';
import type { ScrapeFormat } from '../steel/types.js';
import { recordBrowserUrl } from '../telemetry.js';
import { type Provenance, stripHtmlComments, stripInvisible } from '../untrusted.js';
import { cursorSchema, fencedSection, guard, maxTokensSchema, successResult, withPage } from './shared.js';

const FORMATS = ['markdown', 'html', 'cleaned_html', 'readability'] as const;
const MAX_SCRAPE_LINKS = 25;
const MAX_LINK_TEXT_CHARS = 512;
const MAX_LINK_URL_CHARS = 2_048;
const MAX_METADATA_FIELDS = 25;
const MAX_METADATA_VALUE_CHARS = 1_024;

export const MAX_INLINE_SCREENSHOT_BYTES = 4 * 1024 * 1024;

async function publishArtifact(
    deps: ServerDeps,
    data: string,
    mimeType: string,
    filename: string
): Promise<PublishedArtifact | undefined> {
    if (!deps.artifacts) return undefined;
    try {
        return await deps.artifacts.publish({ principal: deps.principal, data, mimeType, filename });
    } catch {
        // The original MCP attachment is still a valid result. Artifact hosting is an inter-tool
        // convenience and must not turn a successful browser capture into a failed tool call.
        return undefined;
    }
}

function artifactLink(artifact: PublishedArtifact, title: string, description: string): ContentBlock {
    return {
        type: 'resource_link',
        uri: artifact.url,
        name: new URL(artifact.url).pathname.split('/').at(-1) ?? 'artifact',
        title,
        mimeType: artifact.mimeType,
        size: artifact.size,
        description,
        annotations: { audience: ['user'] },
    };
}

function artifactHandoffNotes(artifact: PublishedArtifact): string[] {
    return [
        `The signed download URL expires at ${artifact.expiresAt}.`,
        'To send this image in Tlon: call the tlon tool with command "upload <Download URL>". Copy the HTTPS URL it returns, then call the message tool with media set to that returned URL.',
        'Uploading alone sends nothing. The MCP image attachment, resource link, tool-image filename, and a text reply containing a URL are not Tlon attachments; do not claim the image was sent until the message tool succeeds with media set.',
    ];
}

type ArtifactDownload =
    | { state: 'embedded'; base64: string; size: number }
    | { state: 'link_only'; reason: 'download_failed' | 'http_error' | 'invalid_type' | 'too_large' };

/** Whether an artifact-read failure is really caller cancellation and must not degrade to success. */
function isAbort(error: unknown, signal: AbortSignal): boolean {
    return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

/** Reads a Steel attachment into an MCP image block only while it remains safe and small. */
async function downloadArtifact(deps: ServerDeps, url: string, signal: AbortSignal): Promise<ArtifactDownload> {
    let response: Response;
    try {
        response = await (deps.artifactFetch ?? globalThis.fetch)(url, { signal });
    } catch (error) {
        if (isAbort(error, signal)) throw error;
        return { state: 'link_only', reason: 'download_failed' };
    }

    if (!response.ok) return { state: 'link_only', reason: 'http_error' };
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'image/png') {
        return { state: 'link_only', reason: 'invalid_type' };
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_INLINE_SCREENSHOT_BYTES) {
        await response.body?.cancel();
        return { state: 'link_only', reason: 'too_large' };
    }
    if (!response.body) return { state: 'link_only', reason: 'download_failed' };

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_INLINE_SCREENSHOT_BYTES) {
                await reader.cancel();
                return { state: 'link_only', reason: 'too_large' };
            }
            chunks.push(value);
        }
    } catch (error) {
        if (isAbort(error, signal)) throw error;
        return { state: 'link_only', reason: 'download_failed' };
    }

    return { state: 'embedded', base64: Buffer.concat(chunks, size).toString('base64'), size };
}

const INLINE_FALLBACK_NOTES: Record<Extract<ArtifactDownload, { state: 'link_only' }>['reason'], string> = {
    download_failed: 'The screenshot is available from the download link, but its inline preview could not be read.',
    http_error: 'The screenshot is available from the download link, but its inline preview could not be downloaded.',
    invalid_type: 'The screenshot is available from the download link, but the response was not a PNG.',
    too_large: `The screenshot is available from the download link, but it exceeds the ${MAX_INLINE_SCREENSHOT_BYTES / (1024 * 1024)} MiB inline limit.`,
};

/** Formats that carry raw markup, where an HTML comment can hide instructions a person never sees. */
const MARKUP_FORMATS = new Set<ScrapeFormat>(['html', 'cleaned_html']);

function renderContent(content: Partial<Record<ScrapeFormat, unknown>>, formats: ScrapeFormat[]): string {
    return formats
        .map(format => {
            const value = content[format];
            if (value === undefined) return '';
            const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            const body = MARKUP_FORMATS.has(format) ? stripHtmlComments(raw) : raw;
            return formats.length === 1 ? body : `--- ${format} ---\n${body}`;
        })
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Renders the links and metadata a scrape always returns.
 *
 * Both are page-derived — anchor text and an OG title are written by whoever wrote the page — so
 * they go inside the fence with the content. Emitting them outside it would make the server
 * instructions claim a protection the server does not apply.
 */
function renderLinksAndMetadata(
    links: Array<{ url: string; text?: string }>,
    metadata: Record<string, unknown>,
    totalLinks: number
): string {
    const linkLines = links
        .slice(0, 100)
        .map(link => `- ${link.text ? `${stripInvisible(link.text)}: ` : ''}${stripInvisible(link.url)}`)
        .join('\n');

    const metadataLines = Object.entries(metadata)
        .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
        .map(([key, value]) => `- ${key}: ${stripInvisible(String(value))}`)
        .join('\n');

    const body = [
        linkLines
            ? `Links (${totalLinks}${totalLinks > links.length ? `, showing ${links.length}` : ''}):\n${linkLines}`
            : 'Links: none on this page.',
        metadataLines ? `Metadata:\n${metadataLines}` : '',
    ]
        .filter(Boolean)
        .join('\n\n');

    return body;
}

/** Removes smuggling characters from the machine-readable copy a host may render directly. */
function sanitizeStructured<T>(value: T): T {
    if (typeof value === 'string') return stripInvisible(value) as T;
    if (Array.isArray(value)) return value.map(item => sanitizeStructured(item)) as T;
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeStructured(item)])
        ) as T;
    }
    return value;
}

function boundedLinks(links: Array<{ url: string; text?: string }>): Array<{ url: string; text?: string }> {
    return links.slice(0, MAX_SCRAPE_LINKS).map(link => ({
        url: stripInvisible(link.url).slice(0, MAX_LINK_URL_CHARS),
        ...(link.text === undefined ? {} : { text: stripInvisible(link.text).slice(0, MAX_LINK_TEXT_CHARS) }),
    }));
}

function boundedMetadata(metadata: Record<string, unknown>): Record<string, string | number> {
    return Object.fromEntries(
        Object.entries(metadata)
            .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
            .slice(0, MAX_METADATA_FIELDS)
            .map(([key, value]) => [
                stripInvisible(key).slice(0, 128),
                typeof value === 'number' ? value : stripInvisible(String(value)).slice(0, MAX_METADATA_VALUE_CHARS),
            ])
    );
}

export function registerScrape(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'browser_scrape',
        {
            title: 'Read a web page',
            description:
                'Read a web page as markdown or HTML through a real browser, so JavaScript-rendered pages and ' +
                'sites that block plain HTTP fetches still work. Starts no browser session, so there is nothing ' +
                'to release afterwards. Always returns the page links and metadata alongside the content. ' +
                'Use this first for anything you only need to read; reach for browser_session_create only when you ' +
                'need to click, type or move through several pages.',
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
            inputSchema: z
                .object({
                    url: z.url().describe('The page to read.'),
                    format: z
                        .array(z.enum(FORMATS))
                        .optional()
                        .describe('Formats to return. Each extra format repeats the page inside the shared budget.'),
                    use_proxy: z
                        .boolean()
                        .optional()
                        .describe('Request an additional provider-managed proxy when this deployment supports it.'),
                    delay_ms: z.number().int().min(0).max(30_000).optional().describe('Wait this long after load.'),
                    max_tokens: maxTokensSchema,
                    cursor: cursorSchema,
                })
                .strict(),
        },
        async (args, ctx) =>
            guard(deps, 'browser_scrape', ctx.mcpReq, async () => {
                const format = (args.format ?? ['markdown']) as ScrapeFormat[];
                const response = await deps.api.scrape(
                    {
                        url: args.url,
                        format,
                        useProxy: args.use_proxy,
                        delay: args.delay_ms,
                    },
                    ctx.mcpReq.signal
                );

                const finalUrl = response.metadata.urlSource ?? args.url;
                recordBrowserUrl('final', finalUrl, deps.config.traceUrlPaths);
                const body = renderContent(response.content, format);

                const block = detectBotBlock({
                    status: response.metadata.statusCode ?? 200,
                    body: body.slice(0, 4096),
                    finalUrl,
                });
                if (block && (response.metadata.statusCode ?? 200) >= 400) {
                    throw botDetectionError(block, finalUrl, { useProxy: args.use_proxy });
                }

                const provenance: Provenance = { finalUrl, fetchedAt: deps.now().toISOString() };
                const links = boundedLinks(response.links);
                const metadata = boundedMetadata(response.metadata);
                const pageOutput = [body, renderLinksAndMetadata(links, metadata, response.links.length)]
                    .filter(Boolean)
                    .join('\n\n');
                const { text, pagination } = fencedSection(pageOutput, provenance, {
                    maxTokens: args.max_tokens,
                    cursor: args.cursor,
                });

                return successResult(
                    {
                        result: `Read ${finalUrl} (HTTP ${response.metadata.statusCode ?? 'unknown'}).`,
                        snapshot: text,
                        pagination,
                        notes: block
                            ? [`This page carries ${block.vendor} anti-bot markers; content may be partial.`]
                            : undefined,
                    },
                    {
                        final_url: finalUrl,
                        metadata: sanitizeStructured(metadata),
                        links: sanitizeStructured(links),
                        total_links: response.links.length,
                    }
                );
            })
    );
}

export function registerScreenshot(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'browser_screenshot',
        {
            title: 'Screenshot a web page',
            description:
                'Capture a page image. URL captures are user-facing PNG artifacts; session captures are model-visible ' +
                'JPEG evidence. Pixels are not action targets, so use browser_snapshot to click or type. To send the ' +
                'capture in Tlon, call the tlon tool with command "upload <Download URL>", copy the HTTPS URL it ' +
                'returns, then call the message tool with media set to that returned URL. Uploading alone, quoting a ' +
                'URL, or referring to tool-image.jpg does not attach it to a message.',
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
            inputSchema: z
                .object({
                    url: z.url().optional().describe('Page to capture. Starts no browser session.'),
                    session_id: z
                        .string()
                        .optional()
                        .describe('Capture the current page of this session instead. Returns the image inline.'),
                    full_page: z
                        .boolean()
                        .optional()
                        .describe('Capture the whole scrollable page, not just the viewport.'),
                    use_proxy: z
                        .boolean()
                        .optional()
                        .describe('Request an additional provider-managed proxy when this deployment supports it.'),
                    inline: z
                        .boolean()
                        .optional()
                        .describe('For URL captures only: false returns just a link. Defaults to true.'),
                })
                .strict()
                .refine(args => Boolean(args.url) !== Boolean(args.session_id), {
                    message: 'Pass exactly one of url or session_id.',
                })
                .refine(args => !(args.session_id && args.inline === false), {
                    message: 'inline=false is available only for URL captures.',
                })
                .refine(args => !(args.session_id && args.use_proxy !== undefined), {
                    message: 'use_proxy is available only for URL captures.',
                }),
        },
        async (args, ctx) => {
            // The session branch goes through withPage so there is exactly one path that resolves
            // a handle and marks it as used; screenshotting in a loop must not let the reaper
            // reclaim the session out from under the agent doing it.
            if (args.session_id) {
                return withPage(deps, 'browser_screenshot', ctx.mcpReq, args.session_id, async page => {
                    const shot = await page.captureScreenshot({ fullPage: args.full_page ?? false });
                    const artifact = await publishArtifact(deps, shot.data, 'image/jpeg', 'session-screenshot.jpg');
                    return successResult(
                        {
                            result: artifact
                                ? `Captured the current page of this session as a JPEG. Download: ${artifact.url}`
                                : 'Captured the current page of this session as a JPEG.',
                            notes: artifact ? artifactHandoffNotes(artifact) : undefined,
                        },
                        undefined,
                        [
                            { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
                            ...(artifact
                                ? [
                                      artifactLink(
                                          artifact,
                                          'Session screenshot',
                                          'Screenshot of the current browser session page'
                                      ),
                                  ]
                                : []),
                        ]
                    );
                });
            }

            return guard(deps, 'browser_screenshot', ctx.mcpReq, async () => {
                const url = args.url as string;

                const artifact = await deps.api.screenshot(
                    { url, fullPage: args.full_page, useProxy: args.use_proxy },
                    ctx.mcpReq.signal
                );
                const inline = args.inline ?? true;
                if (artifact.kind === 'inline') {
                    if (artifact.mimeType !== 'image/png' && artifact.mimeType !== 'image/jpeg') {
                        throw new SteelToolError(
                            `Self-hosted browser returned an unsupported screenshot type: ${artifact.mimeType}`,
                            { code: 'steel_error' }
                        );
                    }
                    const published = await publishArtifact(
                        deps,
                        artifact.data,
                        artifact.mimeType,
                        artifact.mimeType === 'image/png' ? 'screenshot.png' : 'screenshot.jpg'
                    );
                    const includeImage = inline || !published;
                    const content: ContentBlock[] = [];
                    if (includeImage) {
                        content.push({
                            type: 'image',
                            data: artifact.data,
                            mimeType: artifact.mimeType,
                            annotations: { audience: ['user'] },
                        });
                    }
                    if (published) content.push(artifactLink(published, 'Page screenshot', `Screenshot of ${url}`));
                    return successResult(
                        {
                            result: published
                                ? `Captured ${url}. Download: ${published.url}`
                                : `Captured ${url}. The screenshot is attached inline.`,
                            notes: published
                                ? artifactHandoffNotes(published)
                                : inline === false
                                  ? [
                                        'Artifact hosting is not configured, so this self-hosted browser attached the image inline instead.',
                                    ]
                                  : undefined,
                        },
                        undefined,
                        content
                    );
                }
                const downloaded = inline ? await downloadArtifact(deps, artifact.url, ctx.mcpReq.signal) : undefined;
                const content: ContentBlock[] = [];
                if (downloaded?.state === 'embedded') {
                    content.push({
                        type: 'image',
                        data: downloaded.base64,
                        mimeType: 'image/png',
                        annotations: { audience: ['user'] },
                    });
                }
                content.push({
                    type: 'resource_link',
                    uri: artifact.url,
                    name: 'screenshot.png',
                    title: 'Page screenshot',
                    mimeType: 'image/png',
                    size: downloaded?.state === 'embedded' ? downloaded.size : undefined,
                    description: `Screenshot of ${url}`,
                    annotations: { audience: ['user'] },
                });
                const fallbackNote =
                    downloaded?.state === 'link_only' ? INLINE_FALLBACK_NOTES[downloaded.reason] : undefined;
                return successResult(
                    {
                        result:
                            downloaded?.state === 'embedded'
                                ? `Captured ${url}. The screenshot is attached inline and linked below.`
                                : `Captured ${url}. The screenshot is linked below.`,
                        notes: fallbackNote ? [fallbackNote] : undefined,
                    },
                    undefined,
                    content
                );
            });
        }
    );
}

export function registerPdf(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'browser_pdf',
        {
            title: 'Render a web page as PDF',
            description:
                'Render a page to PDF and return a link to the file. Starts no browser session. Use browser_scrape ' +
                'if you want to read the text — the PDF link is for handing a document to a person.',
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
            inputSchema: z
                .object({
                    url: z.url().describe('The page to render.'),
                    delay_ms: z.number().int().min(0).max(30_000).optional().describe('Wait this long after load.'),
                    use_proxy: z
                        .boolean()
                        .optional()
                        .describe('Request an additional provider-managed proxy when this deployment supports it.'),
                })
                .strict(),
        },
        async (args, ctx) =>
            guard(deps, 'browser_pdf', ctx.mcpReq, async () => {
                const artifact = await deps.api.pdf(
                    { url: args.url, delay: args.delay_ms, useProxy: args.use_proxy },
                    ctx.mcpReq.signal
                );
                if (artifact.kind === 'inline') {
                    if (artifact.mimeType !== 'application/pdf') {
                        throw new SteelToolError(
                            `Self-hosted browser returned an unsupported PDF type: ${artifact.mimeType}`,
                            { code: 'steel_error' }
                        );
                    }
                    const published = await publishArtifact(deps, artifact.data, artifact.mimeType, 'page.pdf');
                    const content: ContentBlock[] = published
                        ? [artifactLink(published, 'Rendered page PDF', `PDF of ${args.url}`)]
                        : [
                              {
                                  type: 'resource',
                                  resource: {
                                      uri: 'browser-artifact:///page.pdf',
                                      blob: artifact.data,
                                      mimeType: artifact.mimeType,
                                  },
                                  annotations: { audience: ['user'] },
                              },
                          ];
                    return successResult(
                        {
                            result: published
                                ? `Rendered ${args.url} to PDF. Download: ${published.url}`
                                : `Rendered ${args.url} to PDF. The PDF is attached.`,
                            notes: published
                                ? [
                                      `The signed download URL expires at ${published.expiresAt}; pass it directly to an upload tool.`,
                                  ]
                                : undefined,
                        },
                        undefined,
                        content
                    );
                }
                const content: ContentBlock[] = [
                    {
                        type: 'resource_link',
                        uri: artifact.url,
                        name: 'page.pdf',
                        title: 'Rendered page PDF',
                        mimeType: 'application/pdf',
                        description: `PDF of ${args.url}`,
                        annotations: { audience: ['user'] },
                    },
                ];
                return successResult({ result: `Rendered ${args.url} to PDF.` }, undefined, content);
            })
    );
}
