// ABOUTME: Snapshot-bound private field selection shared by login and owner handoffs.
// ABOUTME: Selectors identify controls without carrying their private values.
import { z } from 'zod';

export const formFieldSelectorsSchema = z
    .array(
        z.union([
            z.string().regex(/^@e\d+$/),
            z.object({ name: z.string().min(1).max(512) }).strict(),
            z.object({ label: z.string().min(1).max(1024) }).strict(),
        ])
    )
    .min(1)
    .max(40);

/** Snapshot-issued identity for one private form control. Values are never part of this contract. */
export interface SelectedFormControl {
    backendNodeId: number;
    frameId: string;
    loaderId: string;
    tagName: 'INPUT' | 'TEXTAREA' | 'SELECT';
    type: string;
    name: string;
    id: string;
    label: string;
    formBackendNodeId?: number | undefined;
}

export type FormFieldSelector = string | { name: string } | { label: string };

export interface SelectedFormRequest {
    pageId: string;
    fields: SelectedFormControl[];
}

export type FormHandoffRequest = SelectedFormRequest | { discover: true };

export interface PreparedFormHandoff {
    viewer_url: string;
    expires_at: number;
}
