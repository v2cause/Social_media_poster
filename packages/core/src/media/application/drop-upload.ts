import { uploadKey } from '../domain/storage-keys';
import type { MediaJob } from '../ports/media-jobs';
import type { MediaScope } from '../ports/media-store';
import type { MediaDependencies } from './dependencies';

// media.drop-upload (guide step 8.4): the presigned link of an upload works for five minutes, and
// a PUT it started may end later. A PUT after the pipeline took the file, or after the asset was
// rejected or removed, would create the upload object again, which neither the quota counts nor
// another job deletes. The job of the ticket deletes it once the link has long expired. An asset
// that still waits for its file keeps it, the clean-up removes it after 24 hours (ADR 0038), and
// one in processing too: the pipeline deletes the upload when it is done.

export type DropUploadOutcome = 'DROPPED' | 'KEPT';

export class DropUpload {
  constructor(private readonly deps: Pick<MediaDependencies, 'unitOfWork' | 'storage'>) {}

  async execute(job: MediaJob): Promise<DropUploadOutcome> {
    const scope: MediaScope = {
      userId: null,
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
    };
    const asset = await this.deps.unitOfWork.run(scope, (store) =>
      store.assets.find(job.workspaceId, job.assetId),
    );
    const waiting =
      asset !== null &&
      asset.deletedAt === null &&
      (asset.status === 'PENDING_UPLOAD' || asset.status === 'PROCESSING');
    if (waiting) {
      return 'KEPT';
    }
    // Also without a row: the asset went with its organization or the clean-up.
    await this.deps.storage.delete(uploadKey(job.workspaceId, job.assetId));
    return 'DROPPED';
  }
}
