// ABOUTME: The accessibility snapshot pipeline: joins the AX tree with DOMSnapshot geometry, assigns
// ABOUTME: @eN refs keyed on (loaderId, backendNodeId) and renders a budgeted, redacted page tree.

import safeRegex from 'safe-regex2';
import { type StaleRefReason, SteelToolError, staleRefError } from './errors.js';
import type { CdpSession } from './steel/cdp.js';
import { defangMarkdownLinks, isSensitiveField, redactSensitiveValue, stripInvisible } from './untrusted.js';

/** The computed styles the pipeline needs to decide whether a node can be targeted. */
const COMPUTED_STYLES = ['pointer-events', 'visibility', 'display', 'opacity'] as const;

/** One node of a rendered snapshot. Only nodes with a `ref` can be targeted by an action. */
export interface SnapshotNode {
    /** `@eN`, present only on nodes that are visible and receive pointer events. */
    ref?: string | undefined;
    role: string;
    name: string;
    /** True when the name was synthesised because the element has no accessible name. */
    nameInferred: boolean;
    value?: string | undefined;
    backendNodeId: number;
    depth: number;
    inViewport: boolean;
    interactive: boolean;
    /** True for a form control whose value must never be echoed back, such as a password input. */
    sensitive: boolean;
    properties?: Record<string, string | number | boolean> | undefined;
    /** Element centre in CSS pixels, used to dispatch pointer events. */
    center?: { x: number; y: number } | undefined;
}

/** A captured page snapshot, versioned so a stale ref can be diagnosed precisely. */
export interface PageSnapshot {
    snapshotId: string;
    loaderId: string;
    url: string;
    title: string;
    nodes: SnapshotNode[];
    text: string;
    /** Nodes omitted from `text` because the budget ran out; paginate with a cursor. */
    truncated: boolean;
}

export interface CaptureOptions {
    /** Elide purely structural containers, keeping targetable and text-bearing nodes. Default true. */
    interactiveOnly?: boolean | undefined;
    /** Maximum tree depth to render. */
    maxDepth?: number | undefined;
    /** Cap on rendered nodes, so a huge page cannot blow the host's response budget. */
    maxNodes?: number | undefined;
}

/** What a `@eN` ref points at, plus the identity recorded when the ref was issued. */
export interface ResolvedRef {
    ref: string;
    backendNodeId: number;
    loaderId: string;
    role: string;
    name: string;
    snapshotId: string;
    center?: { x: number; y: number } | undefined;
}

interface RefRecord extends ResolvedRef {
    /** Set when a later capture no longer contained the node. */
    lastSeenSnapshotId: string;
}

interface AxNode {
    nodeId: string;
    ignored?: boolean;
    role?: { value?: unknown };
    name?: { value?: unknown };
    value?: { value?: unknown };
    properties?: Array<{ name: string; value?: { value?: unknown } }>;
    childIds?: string[];
    backendDOMNodeId?: number;
    parentId?: string;
}

interface DomFacts {
    tagName: string;
    attributes: Record<string, string>;
    inputValue: string | undefined;
    bounds: [number, number, number, number] | undefined;
    styles: Record<string, string>;
    /** Chrome's own judgement that the node responds to a click. */
    clickable: boolean;
}

/** Roles whose text is worth keeping even when the caller asked for interactive nodes only. */
const TEXT_BEARING_ROLES = new Set([
    'RootWebArea',
    'heading',
    'paragraph',
    'StaticText',
    'text',
    'alert',
    'status',
    'article',
    'list',
    'listitem',
    'table',
    'row',
    'cell',
    'columnheader',
    'rowheader',
    'dialog',
    'alertdialog',
]);

/** Roles that describe the document or a text run rather than something a model can act on. */
const NEVER_TARGETABLE_ROLES = new Set([
    'RootWebArea',
    'WebArea',
    'InlineTextBox',
    'StaticText',
    'none',
    'presentation',
]);

/**
 * Roles dropped from the tree entirely.
 *
 * `InlineTextBox` is Chrome's per-line breakdown of a `StaticText`; it repeats the same words with
 * no DOM node behind it, which both doubles the token cost and makes every line look off-screen.
 */
const DROPPED_ROLES = new Set(['InlineTextBox']);

/** AX properties worth surfacing; everything else is noise in a context window. */
const USEFUL_PROPERTIES = new Set([
    'level',
    'checked',
    'selected',
    'expanded',
    'disabled',
    'required',
    'invalid',
    'pressed',
    'readonly',
]);

const DEFAULT_MAX_NODES = 1_500;

function asString(value: unknown): string {
    return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** Reads the DOMSnapshot payload into a per-backendNodeId fact table. */
function readDomFacts(payload: unknown): Map<number, DomFacts> {
    const facts = new Map<number, DomFacts>();
    const snapshot = payload as {
        strings?: string[];
        documents?: Array<{
            nodes?: {
                nodeName?: number[];
                backendNodeId?: number[];
                attributes?: number[][];
                inputValue?: { index?: number[]; value?: number[] };
                isClickable?: { index?: number[] };
            };
            layout?: { nodeIndex?: number[]; styles?: number[][]; bounds?: number[][] };
        }>;
    };
    const strings = snapshot.strings ?? [];
    const text = (index: number | undefined): string =>
        index === undefined || index < 0 ? '' : (strings[index] ?? '');

    for (const document of snapshot.documents ?? []) {
        const nodes = document.nodes ?? {};
        const backendIds = nodes.backendNodeId ?? [];
        const inputValues = new Map<number, string>();
        const inputIndex = nodes.inputValue?.index ?? [];
        const inputValue = nodes.inputValue?.value ?? [];
        inputIndex.forEach((nodeIndex, at) => {
            inputValues.set(nodeIndex, text(inputValue[at]));
        });

        const clickable = new Set(document.nodes?.isClickable?.index ?? []);

        const layoutByNode = new Map<number, { styles: number[]; bounds: number[] }>();
        const layoutNodeIndex = document.layout?.nodeIndex ?? [];
        layoutNodeIndex.forEach((nodeIndex, at) => {
            layoutByNode.set(nodeIndex, {
                styles: document.layout?.styles?.[at] ?? [],
                bounds: document.layout?.bounds?.[at] ?? [],
            });
        });

        backendIds.forEach((backendNodeId, nodeIndex) => {
            const attributePairs = nodes.attributes?.[nodeIndex] ?? [];
            const attributes: Record<string, string> = {};
            for (let i = 0; i + 1 < attributePairs.length; i += 2) {
                attributes[text(attributePairs[i]).toLowerCase()] = text(attributePairs[i + 1]);
            }

            const layout = layoutByNode.get(nodeIndex);
            const styles: Record<string, string> = {};
            COMPUTED_STYLES.forEach((name, at) => {
                styles[name] = text(layout?.styles?.[at]);
            });

            const bounds = layout?.bounds;
            facts.set(backendNodeId, {
                tagName: text(nodes.nodeName?.[nodeIndex]),
                attributes,
                inputValue: inputValues.get(nodeIndex),
                bounds:
                    bounds && bounds.length >= 4
                        ? [bounds[0] ?? 0, bounds[1] ?? 0, bounds[2] ?? 0, bounds[3] ?? 0]
                        : undefined,
                styles,
                clickable: clickable.has(nodeIndex),
            });
        });
    }
    return facts;
}

/** Roles a model can meaningfully act on. Structural containers never earn a ref. */
const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'option',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'treeitem',
    'textarea',
    'ComboBox',
    'PopUpButton',
]);

/**
 * Decides whether a node may be targeted: it must be rendered, visible, accept pointer events,
 * and be something a person could actually interact with. A container that merely happens to be
 * visible gets no ref, so the model structurally cannot aim an action at the page background.
 */
function isTargetable(facts: DomFacts | undefined, role: string, focusable: boolean): boolean {
    if (!facts?.bounds) return false;
    const [, , width, height] = facts.bounds;
    if (width <= 0 || height <= 0) return false;
    if (facts.styles['pointer-events'] === 'none') return false;
    if (facts.styles.visibility === 'hidden' || facts.styles.visibility === 'collapse') return false;
    if (NEVER_TARGETABLE_ROLES.has(role)) return false;
    return facts.clickable || focusable || INTERACTIVE_ROLES.has(role);
}

/**
 * Synthesises a name for a node Chrome could not name.
 *
 * A third to a half of buttons and links in the wild have no accessible name, so refusing to
 * name them would make those elements invisible to the model. The guess is flagged so the
 * model can discount it.
 */
function synthesizeName(facts: DomFacts | undefined): string {
    if (!facts) return '';
    const candidates = [
        facts.attributes['aria-label'],
        facts.attributes.title,
        facts.attributes.alt,
        facts.attributes.placeholder,
        facts.attributes.value,
        facts.attributes.name,
    ];
    return candidates.find(candidate => candidate && candidate.trim().length > 0)?.trim() ?? '';
}

function cleanText(value: string): string {
    return defangMarkdownLinks(stripInvisible(value)).replace(/\s+/g, ' ').trim();
}

/**
 * Decides whether an element's identity moved since the snapshot the caller read.
 *
 * Deliberately strict. Distinguishing a cosmetic relabel (`Save` to `Saving…`) from a swapped
 * action (`Save` to `Delete everything`) needs a similarity threshold, and a threshold that guesses
 * wrong clicks the wrong button. So any role or name change counts, and the caller re-reads the
 * page and retries — one extra round trip, against the alternative of a destructive misclick.
 *
 * The one exception is a name appearing or disappearing: Chrome frequently computes an accessible
 * name a beat after layout, and an empty name on either side is no evidence of a different element.
 */
export function identityChanged(
    recorded: Pick<ResolvedRef, 'role' | 'name'>,
    live: Pick<ResolvedRef, 'role' | 'name'>
): boolean {
    if (recorded.role !== live.role) return true;

    const before = recorded.name.trim().toLowerCase();
    const after = live.name.trim().toLowerCase();
    if (before === after) return false;
    return before !== '' && after !== '';
}

/** Renders snapshot nodes as an indented tree, one line per node. */
export function renderSnapshot(nodes: SnapshotNode[]): string {
    return nodes
        .map(node => {
            const indent = '  '.repeat(node.depth);
            const parts = [`- ${node.role}`];
            if (node.name) parts.push(`"${node.name}"`);
            if (node.nameInferred && node.name) parts.push('(inferred)');
            if (node.ref) parts.push(node.ref);
            if (node.value !== undefined) parts.push(`[value=${JSON.stringify(node.value)}]`);
            for (const [key, value] of Object.entries(node.properties ?? {})) parts.push(`[${key}=${value}]`);
            if (!node.inViewport) parts.push('[off-screen]');
            return indent + parts.join(' ');
        })
        .join('\n');
}

export interface FindQuery {
    text?: string | undefined;
    regex?: string | undefined;
    role?: string | undefined;
    interactiveOnly?: boolean | undefined;
}

/** Filters snapshot nodes by name, role or pattern — far cheaper than re-reading a whole page. */
export function findInSnapshot(nodes: SnapshotNode[], query: FindQuery): SnapshotNode[] {
    let matcher: (node: SnapshotNode) => boolean;
    if (query.regex !== undefined) {
        let pattern: RegExp;
        try {
            pattern = new RegExp(query.regex, 'i');
        } catch (error) {
            throw new SteelToolError(
                `"${query.regex}" is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}. ` +
                    'Use the text argument for a plain substring search.',
                { code: 'invalid_argument' }
            );
        }
        if (!safeRegex(pattern, { limit: 25 })) {
            throw new SteelToolError(
                'That regular expression may take too long to evaluate. Use a simpler pattern or the text argument.',
                { code: 'invalid_argument' }
            );
        }
        matcher = node => pattern.test(node.name);
    } else if (query.text !== undefined) {
        const needle = query.text.toLowerCase();
        matcher = node => node.name.toLowerCase().includes(needle);
    } else {
        matcher = () => true;
    }

    const matches = nodes.filter(node => {
        if (query.role && node.role !== query.role) return false;
        if (query.interactiveOnly && !node.ref) return false;
        return matcher(node);
    });

    // A label and the field it labels usually share a name. The field is the one a caller can act
    // on, so targetable matches lead; document order is preserved within each group.
    return [...matches.filter(node => node.ref !== undefined), ...matches.filter(node => node.ref === undefined)];
}

/**
 * Per-session page state: the ref registry and the latest snapshot.
 *
 * Refs are keyed on `(loaderId, backendNodeId)` so a node that survives a DOM mutation keeps its
 * ref even when its role or accessible name changes — a button whose label flips `Save` to
 * `Saving…` must not silently become a different element mid-flow. The ref counter never resets,
 * so a ref issued before a document load can never be reused for a different node afterwards.
 */
export class PageState {
    private readonly refByNode = new Map<string, string>();
    private readonly recordByRef = new Map<string, RefRecord>();
    private refCounter = 0;
    private snapshotCounter = 0;
    private currentLoaderId = '';
    private latest: PageSnapshot | undefined;

    /** The most recent snapshot, or undefined if the page has never been read. */
    get lastSnapshot(): PageSnapshot | undefined {
        return this.latest;
    }

    async capture(session: CdpSession, options: CaptureOptions): Promise<PageSnapshot> {
        const [frameTree, axTree, domSnapshot, metrics] = await Promise.all([
            session.send<{ frameTree?: { frame?: { loaderId?: string; url?: string } } }>('Page.getFrameTree'),
            session.send<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree'),
            session.send('DOMSnapshot.captureSnapshot', {
                computedStyles: [...COMPUTED_STYLES],
                includeDOMRects: true,
            }),
            session.send<{
                cssLayoutViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
            }>('Page.getLayoutMetrics'),
        ]);

        const loaderId = frameTree.frameTree?.frame?.loaderId ?? '';
        const url = frameTree.frameTree?.frame?.url ?? '';
        if (loaderId !== this.currentLoaderId) {
            // A new document invalidates every node identity. The counter deliberately keeps
            // climbing so an old ref resolves to a stale-ref error, never to a different node.
            this.refByNode.clear();
            this.currentLoaderId = loaderId;
        }

        const facts = readDomFacts(domSnapshot);
        const viewport = metrics.cssLayoutViewport ?? {};
        const viewportTop = viewport.pageY ?? 0;
        const viewportLeft = viewport.pageX ?? 0;
        const viewportBottom = viewportTop + (viewport.clientHeight ?? 0);
        const viewportRight = viewportLeft + (viewport.clientWidth ?? 0);

        this.snapshotCounter += 1;
        const snapshotId = `s${this.snapshotCounter}`;

        const axNodes = axTree.nodes ?? [];
        const byId = new Map(axNodes.map(node => [node.nodeId, node]));
        const roots = axNodes.filter(node => node.parentId === undefined || !byId.has(node.parentId));

        const nodes: SnapshotNode[] = [];
        const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
        let truncated = false;

        const visit = (axNode: AxNode, depth: number, parentName: string): void => {
            if (nodes.length >= maxNodes) {
                truncated = true;
                return;
            }
            if (options.maxDepth !== undefined && depth > options.maxDepth) return;

            const children = (axNode.childIds ?? [])
                .map(id => byId.get(id))
                .filter((n): n is AxNode => n !== undefined);
            if (axNode.ignored) {
                // Ignored nodes contribute nothing, but their subtree can still be meaningful.
                for (const child of children) visit(child, depth, parentName);
                return;
            }

            const role = asString(axNode.role?.value) || 'generic';
            if (DROPPED_ROLES.has(role)) return;

            const backendNodeId = axNode.backendDOMNodeId;
            const nodeFacts = backendNodeId === undefined ? undefined : facts.get(backendNodeId);

            const accessibleName = cleanText(asString(axNode.name?.value));
            const inferredName = accessibleName ? '' : cleanText(synthesizeName(nodeFacts));
            const name = accessibleName || inferredName;

            const focusable =
                axNode.properties?.some(property => property.name === 'focusable' && property.value?.value === true) ??
                false;
            const targetable = backendNodeId !== undefined && isTargetable(nodeFacts, role, focusable);
            const bounds = nodeFacts?.bounds;
            const center = bounds ? { x: bounds[0] + bounds[2] / 2, y: bounds[1] + bounds[3] / 2 } : undefined;
            const inViewport = bounds
                ? bounds[1] + bounds[3] > viewportTop &&
                  bounds[1] < viewportBottom &&
                  bounds[0] + bounds[2] > viewportLeft &&
                  bounds[0] < viewportRight
                : false;

            let ref: string | undefined;
            if (targetable && backendNodeId !== undefined) {
                const key = `${loaderId}_${backendNodeId}`;
                ref = this.refByNode.get(key);
                if (!ref) {
                    this.refCounter += 1;
                    ref = `@e${this.refCounter}`;
                    this.refByNode.set(key, ref);
                }
                this.recordByRef.set(ref, {
                    ref,
                    backendNodeId,
                    loaderId,
                    role,
                    name,
                    snapshotId,
                    lastSeenSnapshotId: snapshotId,
                    center,
                });
            }

            const sensitive =
                nodeFacts !== undefined &&
                isSensitiveField({
                    tagName: nodeFacts.tagName,
                    type: nodeFacts.attributes.type,
                    name: nodeFacts.attributes.name,
                    id: nodeFacts.attributes.id,
                    autocomplete: nodeFacts.attributes.autocomplete,
                });

            const rawValue = nodeFacts?.inputValue ?? (axNode.value ? asString(axNode.value.value) : undefined);
            const value =
                rawValue === undefined ? undefined : sensitive ? redactSensitiveValue(rawValue) : cleanText(rawValue);

            const properties: Record<string, string | number | boolean> = {};
            for (const property of axNode.properties ?? []) {
                if (!USEFUL_PROPERTIES.has(property.name)) continue;
                const propertyValue = property.value?.value;
                if (propertyValue === undefined || propertyValue === false || propertyValue === 'false') continue;
                properties[property.name] = propertyValue as string | number | boolean;
            }

            // A StaticText child that only repeats its parent's name is pure duplication.
            const repeatsParent = role === 'StaticText' && name !== '' && parentName.includes(name);
            const keep =
                !repeatsParent &&
                (options.interactiveOnly === false ||
                    ref !== undefined ||
                    TEXT_BEARING_ROLES.has(role) ||
                    name.length > 0);

            if (keep) {
                nodes.push({
                    ref,
                    role,
                    name,
                    nameInferred: accessibleName === '' && inferredName !== '',
                    value,
                    backendNodeId: backendNodeId ?? -1,
                    depth,
                    inViewport,
                    interactive: ref !== undefined,
                    sensitive,
                    properties: Object.keys(properties).length > 0 ? properties : undefined,
                    center,
                });
            }

            for (const child of children) visit(child, keep ? depth + 1 : depth, name || parentName);
        };

        for (const root of roots) visit(root, 0, '');

        const snapshot: PageSnapshot = {
            snapshotId,
            loaderId,
            url,
            title: cleanText(nodes[0]?.name ?? ''),
            nodes,
            text: renderSnapshot(nodes),
            truncated,
        };
        this.latest = snapshot;
        return snapshot;
    }

    /** Resolves a `@eN` ref, throwing a precise error naming why it no longer works. */
    resolveRef(ref: string): ResolvedRef {
        const record = this.recordByRef.get(ref);
        if (!record) {
            throw new SteelToolError(
                `${ref} is not a reference this page has issued. Call browser_snapshot or browser_find to get current refs.`,
                { code: 'ref_not_found', details: { ref } }
            );
        }
        const currentSnapshotId = this.latest?.snapshotId ?? record.snapshotId;
        const reason: StaleRefReason | undefined =
            record.loaderId !== this.currentLoaderId
                ? 'page_navigated'
                : record.lastSeenSnapshotId !== currentSnapshotId
                  ? 'node_removed'
                  : undefined;

        if (reason) {
            throw staleRefError(ref, {
                refSnapshotId: record.snapshotId,
                currentSnapshotId,
                reason,
            });
        }
        return record;
    }

    /**
     * Verifies that a target still has the role and accessible name the snapshot recorded.
     *
     * Acting on an element relabelled from `Save` to `Delete everything` between the read and the
     * click is the failure mode this prevents. A cosmetic relabel is not: a button that goes from
     * `Save` to `Saving…` is the same button, and refusing to click it would trade a real bug for
     * a worse one. So a role change always counts, and a name change counts only when neither name
     * contains the other.
     */
    assertIdentityUnchanged(ref: string, live: Pick<ResolvedRef, 'role' | 'name'>): void {
        const record = this.recordByRef.get(ref);
        if (!record) return;
        if (!identityChanged(record, live)) return;
        throw staleRefError(ref, {
            refSnapshotId: record.snapshotId,
            currentSnapshotId: this.latest?.snapshotId ?? record.snapshotId,
            reason: 'role_or_name_changed',
        });
    }
}
