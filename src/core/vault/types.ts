// ABOUTME: The vault's encrypted records and private service protocol. No type here is a secret-return MCP tool.
import { z } from 'zod';

export class VaultError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'VaultError';
    }
}

export const shipSchema = z.string().regex(/^[a-z]{3,6}(?:-[a-z]{6}){0,7}$/);
export const identitySchema = z.object({ planet: shipSchema, moon: shipSchema }).strict();
export type VaultIdentity = z.infer<typeof identitySchema>;

export function canonicalShip(value: string): string {
    return shipSchema.parse(value.replace(/^~/, ''));
}

export const originSchema = z
    .string()
    .max(512)
    .refine(value => {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
        } catch {
            return false;
        }
    });

export const encryptedLoginSchema = identitySchema
    .extend({
        version: z.literal(1),
        id: z.uuid(),
        origin: originSchema,
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
        tag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
        ciphertext: z
            .string()
            .min(4)
            .max(32_768)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict();
export type EncryptedLogin = z.infer<typeof encryptedLoginSchema>;
export type LoginMetadata = Omit<EncryptedLogin, 'nonce' | 'tag' | 'ciphertext'>;

export const loginSecretSchema = z
    .object({
        username: z.string().min(1).max(4096).optional(),
        password: z.string().min(1).max(4096),
        label: z.string().min(1).max(256),
    })
    .strict();
export type LoginSecret = z.infer<typeof loginSecretSchema>;
export type LoginSummary = Pick<EncryptedLogin, 'id' | 'origin' | 'revision' | 'updatedAt'> & {
    label: string;
    username?: string;
};

export type VaultProof = { kind: 'browser'; key: string } | { kind: 'owner'; token: string };
export interface VaultStore {
    verify(identity: VaultIdentity, proof: VaultProof, signal?: AbortSignal): Promise<void>;
    list(identity: VaultIdentity, proof: VaultProof, signal?: AbortSignal): Promise<EncryptedLogin[]>;
    put(
        identity: VaultIdentity,
        proof: VaultProof,
        record: EncryptedLogin,
        expectedRevision: number | null,
        signal?: AbortSignal
    ): Promise<void>;
    delete(
        identity: VaultIdentity,
        proof: VaultProof,
        id: string,
        expectedRevision: number,
        signal?: AbortSignal
    ): Promise<void>;
}

export const secureFieldSchema = z.object({
    id: z.string().regex(/^f\d{1,2}$/),
    purpose: z.string().max(64),
    label: z.string().max(256),
    inputType: z.string().max(32),
    required: z.boolean(),
    maxLength: z.number().int().positive().max(4096).optional(),
    exactLength: z.number().int().positive().max(12).optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});
export const formTargetSchema = z.object({
    formId: z.string().min(1).max(256),
    pageId: z.string().min(1).max(256),
    frameUrl: z.string().max(8192),
    origin: z.string().max(512),
    kind: z.enum(['login', 'details']),
});
export const secureFormSchema = formTargetSchema.extend({
    fields: z.array(secureFieldSchema).min(1).max(40),
    vaultEligible: z.boolean(),
});
export type SecureForm = z.infer<typeof secureFormSchema>;
export type FormTarget = z.infer<typeof formTargetSchema>;

export interface VaultBrowser {
    discover(sessionId: string, signal?: AbortSignal): Promise<SecureForm | null>;
    fill(
        sessionId: string,
        form: SecureForm,
        values: Record<string, string>,
        submit: boolean,
        signal?: AbortSignal
    ): Promise<{ submitted: boolean }>;
}

export function sameIdentity(left: VaultIdentity, right: VaultIdentity): boolean {
    return left.planet === right.planet && left.moon === right.moon;
}

export function loginFields(form: SecureForm): { username?: string; password?: string } | null {
    if (form.kind !== 'login' || !form.vaultEligible || !originSchema.safeParse(form.origin).success) return null;
    const names = form.fields.map(field => field.purpose);
    if (new Set(names).size !== names.length || names.some(name => !['username', 'current-password'].includes(name)))
        return null;
    return {
        username: form.fields.find(field => field.purpose === 'username')?.id,
        password: form.fields.find(field => field.purpose === 'current-password')?.id,
    };
}

export function formTarget(form: SecureForm): FormTarget {
    return formTargetSchema.parse(form);
}

export type LoginOutcome = {
    status: 'no_match' | 'choice_required' | 'filled' | 'needs_input' | 'unavailable';
    submission_attempted?: boolean;
};
