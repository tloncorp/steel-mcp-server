import { z } from 'zod';

const timestamp = z.number().int().nonnegative();
export const browserMonitorStatusSchema = z.object({
    version: z.literal(1),
    epoch: z.string().uuid(),
    revision: timestamp,
    fill: z
        .object({ revision: timestamp, at: timestamp, formId: z.string().max(128), submitted: z.boolean() })
        .optional(),
    form: z.object({ revision: timestamp, at: timestamp, formId: z.string().max(128) }).optional(),
    failure: z.object({ revision: timestamp, at: timestamp }).optional(),
});
export type BrowserMonitorStatus = z.infer<typeof browserMonitorStatusSchema>;
