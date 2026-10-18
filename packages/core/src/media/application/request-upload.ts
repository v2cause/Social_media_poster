import type { ContentActor } from '../../content/domain/types';
import { MediaTooLargeError, MediaTypeNotAllowedError, StorageQuotaExceededError } from '../domain/errors';
import { displayFileName, isUploadMimeType, MAX_UPLOAD_BYTES, UPLOAD_URL_SECONDS } from '../domain/rules';
import { originalKey, uploadKey } from '../domain/storage-keys';
import type { MediaAsset } from '../domain/types';
import type { PresignedUpload } from '../ports/storage';
import { assertCanWriteMedia, mediaScopeOf, type MediaDependencies } from './dependencies';

// Step 1 of an upload (architecture 9): type and size as announced by the browser, the storage the
// plan of the organization allows in all its workspaces (guide step 7.4), then an asset waiting
// for its file and a presigned PUT for exactly that type and length into the upload object, apart
// from the original the pipeline writes after its checks (guide step 8.4).

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
    const allowed = await this.deps.limits.storageBytes(actor.organizationId);
    await this.deps.unitOfWork.run(mediaScopeOf(actor), async (store) => {
      await store.assets.lockStorage(actor.organizationId);
      // Counted after the lock: an upload that held it before is committed by now.
      const used = await this.deps.limits.storageUsed(actor.organizationId);
      if (used + input.size > allowed) {
        throw new StorageQuotaExceededError();
      }
      await store.assets.insert(asset);
    });
    const upload = await this.deps.storage.presignPut(uploadKey(actor.workspaceId, assetId), {
      contentType: mimeType,
      contentLength: input.size,
      expiresInSeconds: UPLOAD_URL_SECONDS,
    });
    const expiresAt = new Date(this.deps.clock.now().getTime() + UPLOAD_URL_SECONDS * 1000);
    return { asset, upload, expiresAt };
  }
}
