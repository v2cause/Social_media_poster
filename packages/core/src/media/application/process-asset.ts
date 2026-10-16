import { RENDITION_PROFILES } from '@smp/platform-rules';

import { ImageRejectedError } from '../domain/errors';
import { sniffImageType } from '../domain/file-signature';
import { FULL_IMAGE, isUploadMimeType, MAX_UPLOAD_BYTES, THUMBNAIL_PROFILES } from '../domain/rules';
import { assetPrefix, renditionKey } from '../domain/storage-keys';
import type { MediaAsset, MediaRejectReason, MediaRendition } from '../domain/types';
import type { MediaJob } from '../ports/media-jobs';
import type { MediaScope } from '../ports/media-store';
import type { MediaDependencies } from './dependencies';

// media.process (guide step 3.3, architecture 9): the worker checks the content, not the
// announced type: magic bytes, then the decoder with its pixel limit. Accepted images get WebP
// thumbnails, their size after the EXIF orientation and the SHA-256 of the file. A refused file
// is deleted from the storage. The original itself is never delivered.

export type ProcessOutcome = 'READY' | 'REJECTED' | 'SKIPPED';

const reasonOfType = (type: ReturnType<typeof sniffImageType>): MediaRejectReason | null => {
  if (type === null) {
    return 'NOT_AN_IMAGE';
  }
  if (type === 'image/heic') {
    return 'HEIC_NOT_SUPPORTED';
  }
  return isUploadMimeType(type) ? null : 'UNSUPPORTED_FORMAT';
};

export class ProcessAsset {
  constructor(
    private readonly deps: Pick<MediaDependencies, 'unitOfWork' | 'storage' | 'processor' | 'clock' | 'ids'>,
  ) {}

  async execute(job: MediaJob): Promise<ProcessOutcome> {
    const scope: MediaScope = {
      userId: null,
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
    };
    const asset = await this.deps.unitOfWork.run(scope, (store) =>
      store.assets.find(job.workspaceId, job.assetId),
    );
    // A job for an asset that moved on (deleted, already done) has nothing left to do.
    if (!asset || asset.deletedAt !== null || asset.status !== 'PROCESSING') {
      return 'SKIPPED';
    }

    const bytes = await this.deps.storage.get(asset.storageKey, { maxBytes: MAX_UPLOAD_BYTES });
    const type = sniffImageType(bytes);
    const typeReason = reasonOfType(type);
    if (typeReason !== null || type === null) {
      return this.reject(scope, asset, typeReason ?? 'NOT_AN_IMAGE');
    }

    try {
      const info = await this.deps.processor.inspect(bytes);
      if (info.frames > 1) {
        return await this.reject(scope, asset, 'ANIMATED_NOT_SUPPORTED');
      }
      const thumbnails: MediaRendition[] = [];
      for (const profile of THUMBNAIL_PROFILES) {
        const { format, quality, maxWidth, maxHeight } = RENDITION_PROFILES[profile];
        const encoded = await this.deps.processor.encode(bytes, { format, quality, maxWidth, maxHeight });
        const storageKey = renditionKey(asset.workspaceId, asset.id, {
          profile,
          cropHash: FULL_IMAGE,
          extension: format,
        });
        await this.deps.storage.put(storageKey, encoded.bytes, { contentType: encoded.mimeType });
        thumbnails.push({
          id: this.deps.ids.newId(),
          workspaceId: asset.workspaceId,
          assetId: asset.id,
          profile,
          cropHash: FULL_IMAGE,
          storageKey,
          mimeType: encoded.mimeType,
          width: encoded.width,
          height: encoded.height,
          sizeBytes: encoded.bytes.byteLength,
        });
      }
      const result = {
        mimeType: type,
        width: info.width,
        height: info.height,
        sha256: this.deps.processor.sha256(bytes),
        processedAt: this.deps.clock.now(),
      };
      const finished = await this.deps.unitOfWork.run(scope, async (store) => {
        for (const thumbnail of thumbnails) {
          await store.renditions.upsert(thumbnail);
        }
        return store.assets.finishProcessing(asset.workspaceId, asset.id, result);
      });
      return finished ? 'READY' : 'SKIPPED';
    } catch (error) {
      if (error instanceof ImageRejectedError) {
        return await this.reject(scope, asset, error.reason);
      }
      throw error;
    }
  }

  /** Removes the file and whatever was already derived from it, then marks the asset. */
  private async reject(
    scope: MediaScope,
    asset: MediaAsset,
    reason: MediaRejectReason,
  ): Promise<ProcessOutcome> {
    await this.deps.storage.deletePrefix(assetPrefix(asset.workspaceId, asset.id));
    await this.deps.unitOfWork.run(scope, (store) =>
      store.assets.reject(asset.workspaceId, asset.id, reason, asset.sizeBytes),
    );
    return 'REJECTED';
  }
}
