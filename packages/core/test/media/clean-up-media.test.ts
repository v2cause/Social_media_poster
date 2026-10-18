import { describe, expect, it } from 'vitest';

import {
  CleanUpMedia,
  DELETED_MEDIA_DAYS,
  PENDING_UPLOAD_HOURS,
  type ExpiredAsset,
  type ExpiredMediaCutoffs,
  type MediaCleanupStore,
} from '../../src';
import { fixedClock } from '../in-memory-content';

// Guide step 8.3 with architecture 9: an asset removed from the library goes 30 days later and an
// upload that never completed after 24 hours, unless a variant uses it. The objects under the
// prefix of the asset go before its row; a failed deletion of the objects leaves the row for the
// next run.

const NOW = '2026-10-18T05:00:00Z';
const HOUR = 60 * 60 * 1000;
const hoursAgo = (hours: number): Date => new Date(Date.parse(NOW) - hours * HOUR);
const WORKSPACE = '0199a3c4-0000-7000-8000-000000000001';

interface Row {
  id: string;
  status: 'PENDING_UPLOAD' | 'READY';
  createdAt: Date;
  deletedAt: Date | null;
  used: boolean;
}

class MemoryMedia implements MediaCleanupStore {
  rows: Row[] = [];

  private isExpired(row: Row, cutoffs: ExpiredMediaCutoffs): boolean {
    if (row.used) {
      return false;
    }
    const deleted = row.deletedAt !== null && row.deletedAt < cutoffs.deletedBefore;
    const pending = row.status === 'PENDING_UPLOAD' && row.createdAt < cutoffs.pendingBefore;
    return deleted || pending;
  }

  expired(cutoffs: ExpiredMediaCutoffs, limit: number): Promise<ExpiredAsset[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => this.isExpired(row, cutoffs))
        .slice(0, limit)
        .map((row) => ({ workspaceId: WORKSPACE, assetId: row.id })),
    );
  }

  remove(assetIds: readonly string[], cutoffs: ExpiredMediaCutoffs): Promise<number> {
    const due = this.rows.filter((row) => assetIds.includes(row.id) && this.isExpired(row, cutoffs));
    this.rows = this.rows.filter((row) => !due.includes(row));
    return Promise.resolve(due.length);
  }
}

class MemoryObjects {
  readonly keys = new Set<string>();
  failOn: string | null = null;

  deletePrefix(prefix: string): Promise<number> {
    if (this.failOn !== null && prefix.includes(this.failOn)) {
      return Promise.reject(new Error('storage unavailable'));
    }
    const matching = [...this.keys].filter((key) => key.startsWith(prefix));
    for (const key of matching) {
      this.keys.delete(key);
    }
    return Promise.resolve(matching.length);
  }
}

const asset = (id: string, patch: Partial<Row>): Row => ({
  id,
  status: 'READY',
  createdAt: hoursAgo(24 * 90),
  deletedAt: null,
  used: false,
  ...patch,
});

const filesOf = (objects: MemoryObjects, id: string): void => {
  objects.keys.add(`ws/${WORKSPACE}/assets/${id}/original`);
  objects.keys.add(`ws/${WORKSPACE}/assets/${id}/renditions/thumb_320-full.webp`);
};

describe('CleanUpMedia', () => {
  it('deletes removed assets after 30 days and uncompleted uploads after 24 hours, objects first', async () => {
    const store = new MemoryMedia();
    const objects = new MemoryObjects();
    store.rows = [
      asset('removed-old', { deletedAt: hoursAgo(DELETED_MEDIA_DAYS * 24 + 1) }),
      asset('removed-recent', { deletedAt: hoursAgo(DELETED_MEDIA_DAYS * 24 - 1) }),
      asset('pending-old', { status: 'PENDING_UPLOAD', createdAt: hoursAgo(PENDING_UPLOAD_HOURS + 1) }),
      asset('pending-recent', { status: 'PENDING_UPLOAD', createdAt: hoursAgo(PENDING_UPLOAD_HOURS - 1) }),
      // Used by a variant despite its removal: it stays with its files.
      asset('removed-used', { deletedAt: hoursAgo(24 * 60), used: true }),
      asset('library', {}),
    ];
    for (const row of store.rows) {
      filesOf(objects, row.id);
    }

    const cleanUp = new CleanUpMedia({ store, storage: objects, clock: fixedClock(NOW) });
    await expect(cleanUp.execute()).resolves.toEqual({ mediaDeleted: 2, mediaObjectsDeleted: 4 });

    expect(store.rows.map((row) => row.id)).toEqual([
      'removed-recent',
      'pending-recent',
      'removed-used',
      'library',
    ]);
    expect([...objects.keys].some((key) => key.includes('removed-old') || key.includes('pending-old'))).toBe(
      false,
    );
    expect(objects.keys.size).toBe(8);
  });

  it('keeps the row when its objects could not be deleted, for the next run', async () => {
    const store = new MemoryMedia();
    const objects = new MemoryObjects();
    store.rows = [asset('removed-old', { deletedAt: hoursAgo(24 * 40) })];
    filesOf(objects, 'removed-old');
    objects.failOn = 'removed-old';
    const cleanUp = new CleanUpMedia({ store, storage: objects, clock: fixedClock(NOW) });

    await expect(cleanUp.execute()).rejects.toThrow('storage unavailable');
    expect(store.rows).toHaveLength(1);

    objects.failOn = null;
    await expect(cleanUp.execute()).resolves.toEqual({ mediaDeleted: 1, mediaObjectsDeleted: 2 });
    expect(store.rows).toEqual([]);
  });

  it('works in batches and leaves what is beyond the batches of a run for the next one', async () => {
    const store = new MemoryMedia();
    const objects = new MemoryObjects();
    for (let index = 0; index < 1_050; index += 1) {
      store.rows.push(asset(`removed-${String(index)}`, { deletedAt: hoursAgo(24 * 40) }));
    }
    const cleanUp = new CleanUpMedia({ store, storage: objects, clock: fixedClock(NOW) });

    await expect(cleanUp.execute()).resolves.toMatchObject({ mediaDeleted: 1_000 });
    await expect(cleanUp.execute()).resolves.toMatchObject({ mediaDeleted: 50 });
    expect(store.rows).toEqual([]);
  });
});
