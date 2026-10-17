import { NotPermittedError } from '../../shared/domain/errors';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import type { ContentActor } from '../../content/domain/types';
import { canWriteMedia } from '../domain/rules';
import type { ImageProcessor } from '../ports/image-processor';
import type { MediaJobs } from '../ports/media-jobs';
import type { MediaScope, MediaUnitOfWork } from '../ports/media-store';
import type { StoragePort } from '../ports/storage';

/** The storage of an organization: what its plan allows and what its workspaces store (guide step 7.4). */
export interface MediaLimits {
  /** The originals the plan allows in all workspaces, in bytes. */
  storageBytes(organizationId: string): Promise<number>;
  /** The bytes all workspaces store: every asset neither deleted nor rejected. */
  storageUsed(organizationId: string): Promise<number>;
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
