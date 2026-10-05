// ABOUTME: The planet-backed login vault. Only private browser operations receive decrypted passwords.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { HandleRecord, HandleRegistry } from '../registry.js';
import { principalFromCredential } from '../registry.js';
import type { VaultCipher } from './crypto.js';
import {
    type EncryptedLogin,
    type FormTarget,
    formTarget,
    identitySchema,
    type LoginOutcome,
    type LoginSecret,
    type LoginSummary,
    loginFields,
    type SecureForm,
    type VaultBrowser,
    VaultError,
    type VaultIdentity,
    type VaultProof,
    type VaultStore,
} from './types.js';

const HANDOFF_MS = 5 * 60_000;
const MAX_HANDOFFS = 256;
export const recordChoiceSchema = z.object({ id: z.uuid(), revision: z.number().int().positive() }).strict();
type RecordChoice = z.infer<typeof recordChoiceSchema>;
export const vaultFillSchema = z
    .object({
        handoffId: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/),
        values: z.record(z.string().regex(/^f\d{1,2}$/), z.string().max(4096)).optional(),
        submit: z.boolean(),
        grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        save: z
            .object({ label: z.string().trim().min(1).max(256).optional(), update: recordChoiceSchema.optional() })
            .strict()
            .optional(),
        use: recordChoiceSchema.optional(),
    })
    .strict()
    .refine(value => Boolean(value.save) !== Boolean(value.use));
export type VaultFill = z.infer<typeof vaultFillSchema>;
export type SaveStatus = 'saved' | 'pending' | 'failed';
export type FillResult = { ok: true; submitted: boolean; saveStatus?: SaveStatus };

type BoundSession = {
    identity: VaultIdentity;
    credential: string;
    handle: string;
    principal: string;
    expiresAt: number;
    attempts: Set<string>;
    flowVersion: number;
    selected?: RecordChoice & { origin: string; expiresAt: number };
    pending?: { origin: string; username?: string; label?: string; update?: RecordChoice; expiresAt: number };
};
type Handoff = {
    sessionId: string;
    form: SecureForm;
    expiresAt: number;
    grant?: { token: string; ownerToken: string };
};

export interface VaultServiceOptions {
    cipher: VaultCipher;
    store: VaultStore;
    browser: VaultBrowser;
    registry: HandleRegistry;
    now?: () => number;
}

function safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

function summaries(cipher: VaultCipher, identity: VaultIdentity, records: EncryptedLogin[]): LoginSummary[] {
    return records.map(record => {
        const secret = cipher.decrypt(identity, record);
        return {
            id: record.id,
            origin: record.origin,
            revision: record.revision,
            updatedAt: record.updatedAt,
            label: secret.label,
            ...(secret.username ? { username: secret.username } : {}),
        };
    });
}

function validValues(form: SecureForm, values: Record<string, string>): boolean {
    return (
        Object.keys(values).every(id => form.fields.some(field => field.id === id)) &&
        Object.values(values).some(Boolean) &&
        form.fields.every(field => {
            const value = values[field.id];
            if (!value) return !field.required;
            return (
                value.length <= (field.maxLength ?? 4096) &&
                (field.exactLength === undefined || value.length === field.exactLength)
            );
        })
    );
}

export class BrowserVault {
    private readonly sessions = new Map<string, BoundSession>();
    private readonly handoffs = new Map<string, Handoff>();
    private readonly busy = new Set<string>();
    private readonly now: () => number;

    constructor(private readonly options: VaultServiceOptions) {
        this.now = options.now ?? Date.now;
    }

    async bindSession(
        record: HandleRecord,
        identity: VaultIdentity,
        credential: string,
        signal?: AbortSignal
    ): Promise<boolean> {
        this.prune();
        try {
            identitySchema.parse(identity);
            if (record.principal !== principalFromCredential(credential) || record.expiresAt <= this.now())
                return false;
            await this.options.store.verify(identity, { kind: 'browser', key: credential }, signal);
            this.sessions.set(record.steelSessionId, {
                identity,
                credential,
                handle: record.handle,
                principal: record.principal,
                expiresAt: record.expiresAt,
                attempts: new Set(),
                flowVersion: 0,
            });
            return true;
        } catch {
            return false;
        }
    }

    private async session(sessionId: string, agent = false): Promise<BoundSession> {
        this.prune();
        const session = this.sessions.get(sessionId);
        if (!session) throw new VaultError(404, 'The vault session is unavailable. Open a new browser session.');
        try {
            const record = await (agent
                ? this.options.registry.resolveForAgent(session.handle, session.principal)
                : this.options.registry.resolve(session.handle, session.principal));
            if (record.steelSessionId !== sessionId) throw new Error();
        } catch {
            throw new VaultError(409, 'The browser session is unavailable or under human control.');
        }
        return session;
    }

    private clearFlow(session: BoundSession, origin: string): void {
        if (session.pending?.origin !== origin || session.pending.expiresAt <= this.now()) session.pending = undefined;
        if (session.selected?.origin !== origin || session.selected.expiresAt <= this.now())
            session.selected = undefined;
    }

    private async exclusive<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
        if (this.busy.has(sessionId)) throw new VaultError(409, 'A login operation is already in progress.');
        this.busy.add(sessionId);
        try {
            return await action();
        } finally {
            this.busy.delete(sessionId);
        }
    }

    async prepare(
        sessionId: string,
        handoffId: string,
        target: FormTarget,
        expiresAt: number,
        signal?: AbortSignal
    ): Promise<{ available: true; planet: string; moon: string } | { available: false }> {
        return this.exclusive(sessionId, async () => {
            const session = await this.session(sessionId);
            const flowVersion = session.flowVersion;
            this.clearFlow(session, target.origin);
            for (const [id, handoff] of this.handoffs) if (handoff.sessionId === sessionId) this.handoffs.delete(id);
            const form = await this.options.browser.discover(sessionId, signal);
            if (!form || !loginFields(form) || JSON.stringify(formTarget(form)) !== JSON.stringify(target))
                return { available: false };
            await this.options.store.verify(session.identity, { kind: 'browser', key: session.credential }, signal);
            if (session.flowVersion !== flowVersion) return { available: false };
            if (this.handoffs.size >= MAX_HANDOFFS) throw new VaultError(429, 'Too many secure forms are open.');
            this.handoffs.set(handoffId, {
                sessionId,
                form,
                expiresAt: Math.min(expiresAt, session.expiresAt, this.now() + HANDOFF_MS),
            });
            return { available: true, ...session.identity };
        });
    }

    private handoff(id: string): Handoff {
        this.prune();
        const handoff = this.handoffs.get(id);
        if (!handoff) throw new VaultError(401, 'The secure form is invalid, expired, or already used.');
        return handoff;
    }

    async authorize(
        handoffId: string,
        planet: string,
        ownerToken: string,
        signal?: AbortSignal
    ): Promise<{ grant: string; accounts: LoginSummary[] }> {
        const handoff = this.handoff(handoffId);
        const session = await this.session(handoff.sessionId);
        if (planet !== session.identity.planet) throw new VaultError(403, 'This browser belongs to another planet.');
        const records = await this.options.store.list(session.identity, { kind: 'owner', token: ownerToken }, signal);
        if (this.handoffs.get(handoffId) !== handoff || handoff.expiresAt <= this.now())
            throw new VaultError(401, 'The secure form expired.');
        const token = randomBytes(32).toString('base64url');
        handoff.grant = { token, ownerToken };
        return {
            grant: token,
            accounts: summaries(
                this.options.cipher,
                session.identity,
                records.filter(record => record.origin === handoff.form.origin)
            ),
        };
    }

    discard(handoffId: string): void {
        const handoff = this.handoffs.get(handoffId);
        if (handoff) {
            const session = this.sessions.get(handoff.sessionId);
            if (session) session.pending = undefined;
        }
        this.handoffs.delete(handoffId);
    }

    cancelSessionFlow(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.flowVersion += 1;
            session.pending = undefined;
            session.selected = undefined;
        }
        for (const [id, handoff] of this.handoffs) if (handoff.sessionId === sessionId) this.handoffs.delete(id);
    }

    async fill(input: VaultFill, signal?: AbortSignal): Promise<FillResult> {
        const handoff = this.handoff(input.handoffId);
        return this.exclusive(handoff.sessionId, async () => {
            if (
                this.handoffs.get(input.handoffId) !== handoff ||
                !handoff.grant ||
                !safeEqual(input.grant, handoff.grant.token)
            )
                throw new VaultError(403, 'Save or selection authorization is required.');
            const session = await this.session(handoff.sessionId);
            if (this.handoffs.get(input.handoffId) !== handoff)
                throw new VaultError(409, 'The secure form was canceled.');
            const flowVersion = session.flowVersion;
            const ownerProof: VaultProof = { kind: 'owner', token: handoff.grant.ownerToken };
            // Consume before an await: even failures require a fresh handoff and explicit user action.
            this.handoffs.delete(input.handoffId);
            const fields = loginFields(handoff.form);
            if (!fields) throw new VaultError(400, 'This form cannot use saved logins.');
            await this.options.store.verify(session.identity, { kind: 'browser', key: session.credential }, signal);
            const records = (await this.options.store.list(session.identity, ownerProof, signal)).filter(
                record => record.origin === handoff.form.origin
            );
            this.clearFlow(session, handoff.form.origin);
            if (this.now() >= Math.min(handoff.expiresAt, session.expiresAt))
                throw new VaultError(401, 'The secure form expired.');
            if (session.flowVersion !== flowVersion) throw new VaultError(409, 'The secure form was canceled.');
            const choice = input.use ?? input.save?.update;
            const existing = choice
                ? records.find(record => record.id === choice.id && record.revision === choice.revision)
                : undefined;
            if (choice && !existing)
                throw new VaultError(409, 'The chosen login changed. Refresh before trying again.');
            const previous = existing ? this.options.cipher.decrypt(session.identity, existing) : undefined;
            let values = input.values ?? {};
            let secret: LoginSecret | undefined;
            if (input.use) {
                if (!existing || !previous || Object.keys(values).length)
                    throw new VaultError(400, 'Invalid saved-login selection.');
                values = this.values(handoff.form, previous);
            } else {
                if (!validValues(handoff.form, values))
                    throw new VaultError(400, 'Complete the requested login fields.');
                const username =
                    (fields.username ? values[fields.username] : undefined) ||
                    session.pending?.username ||
                    previous?.username;
                const label = input.save?.label ?? session.pending?.label ?? username?.slice(0, 256) ?? previous?.label;
                if (fields.password) {
                    if (!label) throw new VaultError(400, 'Give this saved login an account label.');
                    secret = { ...(username ? { username } : {}), password: values[fields.password] ?? '', label };
                }
            }
            if (!validValues(handoff.form, values))
                throw new VaultError(400, 'This saved login does not supply the requested fields.');
            if (existing) session.attempts.add(this.attempt(existing, handoff.form));
            const result = await this.options.browser.fill(
                handoff.sessionId,
                handoff.form,
                values,
                input.submit,
                signal
            );
            await this.options.registry.touch(session.handle);
            if (session.flowVersion !== flowVersion)
                return {
                    ok: true,
                    submitted: result.submitted,
                    ...(input.save ? { saveStatus: 'failed' as const } : {}),
                };
            if (input.use && existing) {
                session.selected = {
                    id: existing.id,
                    revision: existing.revision,
                    origin: existing.origin,
                    expiresAt: Math.min(this.now() + HANDOFF_MS, session.expiresAt),
                };
                return { ok: true, submitted: result.submitted };
            }
            if (!fields.password) {
                const username = fields.username ? values[fields.username] : undefined;
                session.pending = {
                    origin: handoff.form.origin,
                    username,
                    label: input.save?.label,
                    update: input.save?.update,
                    expiresAt: Math.min(this.now() + HANDOFF_MS, session.expiresAt),
                };
                return { ok: true, submitted: result.submitted, saveStatus: 'pending' };
            }
            session.pending = undefined;
            try {
                if (!secret) throw new Error();
                if (!existing && records.length >= 200) throw new Error();
                const now = this.now();
                const record = this.options.cipher.encrypt(
                    {
                        ...session.identity,
                        id: existing?.id ?? randomUUID(),
                        origin: handoff.form.origin,
                        revision: (existing?.revision ?? 0) + 1,
                        createdAt: existing?.createdAt ?? now,
                        updatedAt: now,
                    },
                    secret
                );
                await this.options.store.put(session.identity, ownerProof, record, existing?.revision ?? null, signal);
                session.attempts.add(this.attempt(record, handoff.form));
                session.selected = {
                    id: record.id,
                    revision: record.revision,
                    origin: record.origin,
                    expiresAt: Math.min(this.now() + HANDOFF_MS, session.expiresAt),
                };
                return { ok: true, submitted: result.submitted, saveStatus: 'saved' };
            } catch {
                return { ok: true, submitted: result.submitted, saveStatus: 'failed' };
            }
        });
    }

    private values(form: SecureForm, secret: LoginSecret): Record<string, string> {
        const fields = loginFields(form);
        if (!fields) throw new VaultError(400, 'This form cannot use saved logins.');
        return {
            ...(fields.username && secret.username ? { [fields.username]: secret.username } : {}),
            ...(fields.password ? { [fields.password]: secret.password } : {}),
        };
    }

    private attempt(login: EncryptedLogin, form: SecureForm): string {
        return JSON.stringify([login.id, login.revision, login.origin, form.fields.map(field => field.purpose).sort()]);
    }

    async login(record: HandleRecord, signal?: AbortSignal): Promise<LoginOutcome> {
        return this.exclusive(record.steelSessionId, async () => {
            const session = await this.session(record.steelSessionId, true);
            if (session.principal !== record.principal || session.handle !== record.handle)
                throw new VaultError(403, 'This browser belongs to another credential.');
            const form = await this.options.browser.discover(record.steelSessionId, signal);
            if (!form || !loginFields(form)) return { status: 'needs_input' };
            this.clearFlow(session, form.origin);
            const matches = (
                await this.options.store.list(session.identity, { kind: 'browser', key: session.credential }, signal)
            ).filter(login => login.origin === form.origin);
            if (!matches.length) return { status: 'no_match' };
            const selected = session.selected;
            const login = selected
                ? matches.find(match => match.id === selected.id && match.revision === selected.revision)
                : matches.length === 1
                  ? matches[0]
                  : undefined;
            if (!login) return { status: selected ? 'needs_input' : 'choice_required' };
            const attempt = this.attempt(login, form);
            if (session.attempts.has(attempt)) return { status: 'needs_input' };
            const values = this.values(form, this.options.cipher.decrypt(session.identity, login));
            if (!validValues(form, values)) return { status: 'needs_input' };
            if (this.now() >= session.expiresAt) throw new VaultError(401, 'The browser session expired.');
            session.attempts.add(attempt);
            const result = await this.options.browser.fill(record.steelSessionId, form, values, true, signal);
            session.selected = {
                id: login.id,
                revision: login.revision,
                origin: login.origin,
                expiresAt: Math.min(this.now() + HANDOFF_MS, session.expiresAt),
            };
            await this.options.registry.touch(session.handle);
            return { status: 'filled', submission_attempted: result.submitted };
        });
    }

    async list(identity: VaultIdentity, ownerToken: string, signal?: AbortSignal): Promise<LoginSummary[]> {
        return summaries(
            this.options.cipher,
            identity,
            await this.options.store.list(identity, { kind: 'owner', token: ownerToken }, signal)
        );
    }

    async delete(
        identity: VaultIdentity,
        ownerToken: string,
        choice: RecordChoice,
        signal?: AbortSignal
    ): Promise<void> {
        await this.options.store.delete(
            identity,
            { kind: 'owner', token: ownerToken },
            choice.id,
            choice.revision,
            signal
        );
    }

    forgetSession(sessionId: string): void {
        this.sessions.delete(sessionId);
        for (const [id, handoff] of this.handoffs) if (handoff.sessionId === sessionId) this.handoffs.delete(id);
    }

    prune(): void {
        for (const [id, session] of this.sessions) {
            if (session.expiresAt <= this.now()) this.forgetSession(id);
            else {
                if (session.pending && session.pending.expiresAt <= this.now()) session.pending = undefined;
                if (session.selected && session.selected.expiresAt <= this.now()) session.selected = undefined;
            }
        }
        for (const [id, handoff] of this.handoffs) if (handoff.expiresAt <= this.now()) this.handoffs.delete(id);
    }

    close(): void {
        this.sessions.clear();
        this.handoffs.clear();
    }
}
