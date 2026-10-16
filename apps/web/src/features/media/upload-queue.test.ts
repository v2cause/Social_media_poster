import { describe, expect, it } from 'vitest';

import { busy, queuedItem, startable, updated } from './upload-queue';
import { checkFile } from './upload';

const items = (statuses: string[]) =>
  statuses.map((status, index) => ({
    ...queuedItem(`u${String(index)}`, { name: `${String(index)}.jpg`, size: 10 }),
    status: status as 'queued' | 'uploading' | 'done' | 'failed',
  }));

describe('upload queue', () => {
  it('runs at most three uploads at the same time, in the order they were added', () => {
    expect(startable(items(['queued', 'queued', 'queued', 'queued'])).map((item) => item.id)).toEqual([
      'u0',
      'u1',
      'u2',
    ]);
    expect(startable(items(['uploading', 'uploading', 'queued', 'queued'])).map((item) => item.id)).toEqual([
      'u2',
    ]);
    expect(startable(items(['uploading', 'uploading', 'uploading', 'queued']))).toEqual([]);
    expect(startable(items(['done', 'failed', 'queued'])).map((item) => item.id)).toEqual(['u2']);
  });

  it('updates one upload and knows when all are through', () => {
    const list = items(['uploading', 'done']);
    const next = updated(list, 'u0', { status: 'done', progress: 1 });

    expect(next[0]).toMatchObject({ status: 'done', progress: 1 });
    expect(next[1]).toBe(list[1]);
    expect(busy(list)).toBe(true);
    expect(busy(next)).toBe(false);
  });
});

describe('checkFile', () => {
  it('lets JPEG, PNG, WebP and GIF up to 20 MB through and names the reason otherwise', () => {
    expect(checkFile({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(checkFile({ type: 'IMAGE/PNG', size: 20 * 1024 * 1024 })).toBeNull();
    expect(checkFile({ type: 'image/heic', size: 1000 })).toBe('MEDIA_TYPE_NOT_ALLOWED');
    expect(checkFile({ type: '', size: 1000 })).toBe('MEDIA_TYPE_NOT_ALLOWED');
    expect(checkFile({ type: 'image/webp', size: 20 * 1024 * 1024 + 1 })).toBe('MEDIA_TOO_LARGE');
    expect(checkFile({ type: 'image/gif', size: 0 })).toBe('MEDIA_TOO_LARGE');
  });
});
