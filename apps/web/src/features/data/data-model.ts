import type { DataExport } from '@smp/contracts';

// What the data page shows of the exports of an organization (guide step 8.1): the state of each
// export, whether one waits or runs, so that the page asks again, and which one can be fetched.
// For its deletion (guide step 8.2) the owner types the name of the organization.

export type ExportState = 'waiting' | 'running' | 'ready' | 'expired' | 'failed' | 'canceled';

/** How often the page asks while an export waits or runs. */
export const POLL_MS = 3000;

export function stateOf(item: Pick<DataExport, 'status' | 'downloadable'>): ExportState {
  switch (item.status) {
    case 'PENDING':
      return 'waiting';
    case 'RUNNING':
      return 'running';
    case 'COMPLETED':
      return item.downloadable ? 'ready' : 'expired';
    case 'FAILED':
      return 'failed';
    case 'CANCELED':
      return 'canceled';
  }
}

/** The export that waits or runs; there is at most one. */
export const openExportOf = (items: readonly DataExport[]): DataExport | null =>
  items.find((item) => item.status === 'PENDING' || item.status === 'RUNNING') ?? null;

/** The newest export that can be downloaded now. */
export const readyExportOf = (items: readonly DataExport[]): DataExport | null =>
  items.find((item) => stateOf(item) === 'ready') ?? null;

/** The owner typed the name of the organization to confirm its deletion; the API checks it again. */
export const confirmsName = (input: string, name: string): boolean =>
  input.trim().length > 0 && input.trim() === name.trim();
