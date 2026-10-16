import type { ErrorCode, MediaAssetDto } from '@smp/contracts';

// The state of the uploads of a page as pure functions (guide step 3.6): at most three run at the
// same time, the others wait in the order they were added.

export const MAX_PARALLEL_UPLOADS = 3;

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  /** 0 to 1 while uploading. */
  progress: number;
  /** The asset once the upload is complete. */
  asset: MediaAssetDto | null;
  /** An error code of the API, or "storage" when the storage refused the file. */
  error: ErrorCode | 'storage' | 'unknown' | null;
}

export const queuedItem = (id: string, file: { name: string; size: number }): UploadItem => ({
  id,
  name: file.name,
  size: file.size,
  status: 'queued',
  progress: 0,
  asset: null,
  error: null,
});

/** The queued uploads that may start now. */
export function startable(items: readonly UploadItem[], limit = MAX_PARALLEL_UPLOADS): UploadItem[] {
  const running = items.filter((item) => item.status === 'uploading').length;
  return items.filter((item) => item.status === 'queued').slice(0, Math.max(0, limit - running));
}

export const updated = (
  items: readonly UploadItem[],
  id: string,
  patch: Partial<Omit<UploadItem, 'id'>>,
): UploadItem[] => items.map((item) => (item.id === id ? { ...item, ...patch } : item));

/** Whether any upload still waits or runs. */
export const busy = (items: readonly UploadItem[]): boolean =>
  items.some((item) => item.status === 'queued' || item.status === 'uploading');
