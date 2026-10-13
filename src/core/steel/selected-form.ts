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

export interface PreparedFormHandoff {
    viewer_url: string;
    expires_at: number;
}
