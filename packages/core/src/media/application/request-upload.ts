import type { ContentActor } from '../../content/domain/types';
import { MediaTooLargeError, MediaTypeNotAllowedError, StorageQuotaExceededError } from '../domain/errors';
import { displayFileName, isUploadMimeType, MAX_UPLOAD_BYTES, UPLOAD_URL_SECONDS } from '../domain/rules';
import { originalKey } from '../domain/storage-keys';
import type { MediaAsset } from '../domain/types';
import type { PresignedUpload } from '../ports/storage';
import { assertCanWriteMedia, mediaScopeOf, type MediaDependencies } from './dependencies';

// Step 1 of an upload (architecture 9): type and size as announced by the browser, the storage
// quota of the workspace, then an asset waiting for its file and a presigned PUT for it.

export interface RequestUploadInput {
  actor: ContentActor;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface UploadTicket {
  asset: MediaAsset;
  upload: PresignedUpload;
  expiresAt: Date;
}

export class RequestUpload {
  constructor(
    private readonly deps: Pick<MediaDependencies, 'unitOfWork' | 'storage' | 'limits' | 'clock' | 'ids'>,
  ) {}

  async execute(input: RequestUploadInput): Promise<UploadTicket> {
    const { actor } = input;
    assertCanWriteMedia(actor);
    const mimeType = input.mimeType.toLowerCase();
    if (!isUploadMimeType(mimeType)) {
      throw new MediaTypeNotAllowedError();
    }
    if (!Number.isInteger(input.size) || input.size <= 0 || input.size > MAX_UPLOAD_BYTES) {
      throw new MediaTooLargeError();
    }
    const assetId = this.deps.ids.newId();
    const asset: MediaAsset = {
      id: assetId,
      workspaceId: actor.workspaceId,
      status: 'PENDING_UPLOAD',
      fileName: displayFileName(input.fileName),
      declaredMimeType: mimeType,
      declaredSize: input.size,
      storageKey: originalKey(actor.workspaceId, assetId),
      mimeType: null,
      sizeBytes: null,
      width: null,
      height: null,
      sha256: null,
      rejectReason: null,
      altText: null,
      uploadedById: actor.userId,
      version: 0,
      processedAt: null,
      deletedAt: null,
    };
    await this.deps.unitOfWork.run(mediaScopeOf(actor), async (store) => {
      await store.assets.lockStorage(actor.workspaceId);
      const used = await store.assets.storageUsed(actor.workspaceId);
      if (used + input.size > this.deps.limits.storageBytes) {
        throw new StorageQuotaExceededError();
      }
      await store.assets.insert(asset);
    });
    const upload = await this.deps.storage.presignPut(asset.storageKey, {
      contentType: mimeType,
      expiresInSeconds: UPLOAD_URL_SECONDS,
    });
    const expiresAt = new Date(this.deps.clock.now().getTime() + UPLOAD_URL_SECONDS * 1000);
    return { asset, upload, expiresAt };
  }
}
