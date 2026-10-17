import type { DataExport } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import { openExportOf, readyExportOf, stateOf } from './data-model';

const exportOf = (overrides: Partial<DataExport>): DataExport => ({
  id: '0192f000-0000-7000-8000-0000000000e1',
  status: 'COMPLETED',
  requestedAt: '2026-10-17T10:00:00.000Z',
  completedAt: '2026-10-17T10:05:00.000Z',
  expiresAt: '2026-10-18T10:05:00.000Z',
  downloadable: true,
  sizeBytes: 1024,
  ...overrides,
});

describe('the exports on the data page', () => {
  it('names the state of every export', () => {
    expect(stateOf(exportOf({ status: 'PENDING', downloadable: false }))).toBe('waiting');
    expect(stateOf(exportOf({ status: 'RUNNING', downloadable: false }))).toBe('running');
    expect(stateOf(exportOf({}))).toBe('ready');
    expect(stateOf(exportOf({ downloadable: false }))).toBe('expired');
    expect(stateOf(exportOf({ status: 'FAILED', downloadable: false }))).toBe('failed');
    expect(stateOf(exportOf({ status: 'CANCELED', downloadable: false }))).toBe('canceled');
  });

  it('finds the export that waits or runs and the newest one to download', () => {
    const running = exportOf({ id: 'running', status: 'RUNNING', downloadable: false });
    const ready = exportOf({ id: 'ready' });
    const expired = exportOf({ id: 'expired', downloadable: false });

    expect(openExportOf([running, ready, expired])?.id).toBe('running');
    expect(openExportOf([ready, expired])).toBeNull();
    expect(readyExportOf([running, expired, ready])?.id).toBe('ready');
    expect(readyExportOf([running, expired])).toBeNull();
  });
});
