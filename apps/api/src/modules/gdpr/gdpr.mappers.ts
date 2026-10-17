import { isDownloadable, type GdprRequest } from '@smp/core';

import type { DataExportDto } from './gdpr.dto';

/** An export as the data page shows it; the key of its archive stays on the server. */
export const toDataExportDto = (request: GdprRequest, now: Date): DataExportDto => {
  const bytes = request.details['bytes'];
  return {
    id: request.id,
    status: request.status,
    requestedAt: request.createdAt.toISOString(),
    completedAt: request.completedAt?.toISOString() ?? null,
    expiresAt: request.expiresAt?.toISOString() ?? null,
    downloadable: isDownloadable(request, now),
    sizeBytes: typeof bytes === 'number' && request.status === 'COMPLETED' ? bytes : null,
  };
};
