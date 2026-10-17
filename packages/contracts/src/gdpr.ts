import { z } from 'zod';

// The data protection of an organization (guide step 8.1, ADR 0036): the exports of its owners.
// The archive itself is never part of a response; a download asks for a link of a few minutes.

export const GDPR_REQUEST_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELED'] as const;
export const gdprRequestStatusSchema = z.enum(GDPR_REQUEST_STATUSES);
export type GdprRequestStatusDto = z.output<typeof gdprRequestStatusSchema>;

export const dataExportSchema = z.object({
  id: z.uuid(),
  status: gdprRequestStatusSchema,
  requestedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  /** Until when the archive can be downloaded; null before it is finished. */
  expiresAt: z.iso.datetime().nullable(),
  /** Finished, not expired and its archive still there. */
  downloadable: z.boolean(),
  /** The size of the archive, once finished. */
  sizeBytes: z.number().int().nonnegative().nullable(),
});
export type DataExport = z.output<typeof dataExportSchema>;

export const dataExportListSchema = z.object({ items: z.array(dataExportSchema) });
export type DataExportList = z.output<typeof dataExportListSchema>;

export const dataExportDownloadSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  /** The link stops working at this moment. */
  expiresAt: z.iso.datetime(),
});
export type DataExportDownload = z.output<typeof dataExportDownloadSchema>;
