import type { ContentActor } from '../../content/domain/types';
import { MediaNotFoundError, UploadMissingError } from '../domain/errors';
import { MAX_UPLOAD_BYTES } from '../domain/rules';
import type { MediaAsset, MediaRejectReason } from '../domain/types';
import { assertCanWriteMedia, mediaScopeOf, type MediaDependencies } from './dependencies';

// Step 2 of an upload (architecture 9): the browser reports the file as uploaded. The storage
// says what really arrived; an object that breaks the rules is deleted and the asset rejected,
// otherwise media.process takes over. Calling it again is harmless: a processing asset is
// queued once more, every other state is returned as it is.

export interface CompleteUploadInput {
  actor: ContentActor;
  assetId: string;
}

export class CompleteUpload {
  constructor(private readonly deps: Pick<MediaDependencies, 'unitOfWork' | 'storage' | 'jobs'>) {}

  async execute(input: CompleteUploadInput): Promise<MediaAsset> {
    const { actor } = input;
    assertCanWriteMedia(actor);
    const scope = mediaScopeOf(actor);
    const load = () =>
      this.deps.unitOfWork.run(scope, (store) => store.assets.find(actor.workspaceId, input.assetId));
    const asset = await load();
    if (!asset || asset.deletedAt !== null) {
      throw new MediaNotFoundError();
    }
    const job = { organizationId: actor.organizationId, workspaceId: actor.workspaceId, assetId: asset.id };
    if (asset.status === 'PROCESSING') {
      await this.deps.jobs.process(job);
      return asset;
    }
    if (asset.status !== 'PENDING_UPLOAD') {
      return asset;
    }

    const object = await this.deps.storage.head(asset.storageKey);
    if (!object) {
      throw new UploadMissingError();
    }
    let reason: MediaRejectReason | null = null;
    if (object.size > MAX_UPLOAD_BYTES || object.size !== asset.declaredSize) {
      reason = 'SIZE_MISMATCH';
    } else if (object.contentType?.toLowerCase() !== asset.declaredMimeType) {
      reason = 'TYPE_MISMATCH';
    }

    if (reason !== null) {
      const rejection = reason;
      await this.deps.storage.delete(asset.storageKey);
      await this.deps.unitOfWork.run(scope, (store) =>
        store.assets.reject(actor.workspaceId, asset.id, rejection, object.size),
      );
    } else {
      const started = await this.deps.unitOfWork.run(scope, (store) =>
        store.assets.startProcessing(actor.workspaceId, asset.id, object.size),
      );
      if (started) {
        await this.deps.jobs.process(job);
      }
    }
    return (await load()) ?? asset;
  }
}
