import type { Clock } from '../../shared/ports/clock';
import { assetPrefix } from '../domain/storage-keys';
import type { MediaCleanupStore } from '../ports/media-cleanup-store';
import type { StoragePort } from '../ports/storage';

// The clean-up of the media library (architecture 9, guide steps 8.3 and 8.4, ADR 0038), run by
// the hourly sweep of the role "gdpr": an asset removed from the library goes with the next run,
// an upload that never completed after 24 hours, when its link has long expired. A removed asset
// counts against the storage of no plan, so its files do not wait (guide step 8.4). Its objects go
// first, then its row, so a run that fails leaves a row the next run finds again, never objects
// without a row.

export const PENDING_UPLOAD_HOURS = 24;

/** Assets per batch, and batches per run; what a run leaves follows within the hour. */
const BATCH = 100;
const MAX_BATCHES = 10;
const HOUR_MS = 60 * 60 * 1000;

export interface MediaCleanupReport {
  mediaDeleted: number;
  mediaObjectsDeleted: number;
}

export interface MediaCleanupDependencies {
  store: MediaCleanupStore;
  storage: Pick<StoragePort, 'deletePrefix'>;
  clock: Clock;
}

export class CleanUpMedia {
  constructor(private readonly deps: MediaCleanupDependencies) {}

  async execute(): Promise<MediaCleanupReport> {
    const { store, storage } = this.deps;
    const now = this.deps.clock.now().getTime();
    const cutoffs = {
      deletedBefore: new Date(now),
      pendingBefore: new Date(now - PENDING_UPLOAD_HOURS * HOUR_MS),
    };
    let mediaDeleted = 0;
    let mediaObjectsDeleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const assets = await store.expired(cutoffs, BATCH);
      for (const asset of assets) {
        mediaObjectsDeleted += await storage.deletePrefix(assetPrefix(asset.workspaceId, asset.assetId));
      }
      if (assets.length > 0) {
        mediaDeleted += await store.remove(
          assets.map((asset) => asset.assetId),
          cutoffs,
        );
      }
      if (assets.length < BATCH) {
        break;
      }
    }
    return { mediaDeleted, mediaObjectsDeleted };
  }
}
