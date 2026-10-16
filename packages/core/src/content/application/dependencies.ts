import { NotPermittedError } from '../../shared/domain/errors';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import { VersionConflictError } from '../domain/errors';
import { canManageBrand, canWriteContent } from '../domain/rules';
import type { ContentActor } from '../domain/types';
import type { ContentScope, ContentUnitOfWork } from '../ports/content-store';

/** What the content use cases need from the outside. */
export interface ContentDependencies {
  unitOfWork: ContentUnitOfWork;
  clock: Clock;
  ids: IdGenerator;
}

export const scopeOf = (actor: ContentActor): ContentScope => ({
  userId: actor.userId,
  organizationId: actor.organizationId,
  workspaceId: actor.workspaceId,
});

/** The second line behind the permission guard of the API. */
export function assertCanWrite(actor: ContentActor): void {
  if (!canWriteContent(actor.role)) {
    throw new NotPermittedError();
  }
}

export function assertCanManageBrand(actor: ContentActor): void {
  if (!canManageBrand(actor.role)) {
    throw new NotPermittedError();
  }
}

/** Optimistic locking: the client must have read the current version. */
export function assertVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new VersionConflictError();
  }
}

/** A conditional update found no row with the version: someone was faster in between. */
export function assertUpdated(updated: boolean): void {
  if (!updated) {
    throw new VersionConflictError();
  }
}
