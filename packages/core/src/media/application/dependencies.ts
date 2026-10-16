import { NotPermittedError } from '../../shared/domain/errors';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import type { ContentActor } from '../../content/domain/types';
import { canWriteMedia } from '../domain/rules';
import type { ImageProcessor } from '../ports/image-processor';
import type { MediaJobs } from '../ports/media-jobs';
import type { MediaScope, MediaUnitOfWork } from '../ports/media-store';
import type { StoragePort } from '../ports/storage';

/** The storage quota of a workspace until plans set it per organization (phase 7). */
export interface MediaLimits {
  storageBytes: number;
}

/** What the media use cases need from the outside. */
export interface MediaDependencies {
  unitOfWork: MediaUnitOfWork;
  storage: StoragePort;
  jobs: MediaJobs;
  processor: ImageProcessor;
  limits: MediaLimits;
  clock: Clock;
  ids: IdGenerator;
}

export const mediaScopeOf = (actor: ContentActor): MediaScope => ({
  userId: actor.userId,
  organizationId: actor.organizationId,
  workspaceId: actor.workspaceId,
});

/** The second line behind the permission guard of the API. */
export function assertCanWriteMedia(actor: ContentActor): void {
  if (!canWriteMedia(actor.role)) {
    throw new NotPermittedError();
  }
}
