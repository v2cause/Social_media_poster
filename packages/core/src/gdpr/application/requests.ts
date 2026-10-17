import type { StoragePort } from '../../media/ports/storage';
import { NotPermittedError } from '../../shared/domain/errors';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import type { OrganizationActor } from '../../tenancy/domain/types';
import { DataExportUnavailableError } from '../domain/errors';
import { DOWNLOAD_LINK_SECONDS, exportFileNameOf, isDownloadable, type GdprRequest } from '../domain/request';
import type { GdprJobs, GdprScope, GdprUnitOfWork } from '../ports/gdpr-store';

// What the owners of an organization ask for (guide step 8.1, ADR 0036): an export of all its
// data, the list of their exports and a link to download one. Only owners may (architecture 10).
// The archive is never sent by email: the owner downloads it here, signed in, with a link that
// lasts a few minutes, and every download is in the audit log.

export interface GdprDependencies {
  unitOfWork: GdprUnitOfWork;
  jobs: GdprJobs;
  clock: Clock;
  ids: IdGenerator;
}

/** How many exports the list shows. */
const LISTED_EXPORTS = 10;

const assertOwner = (actor: OrganizationActor): void => {
  if (actor.role !== 'OWNER') {
    throw new NotPermittedError();
  }
};

const scopeOf = (actor: OrganizationActor): GdprScope => ({
  userId: actor.userId,
  organizationId: actor.organizationId,
});

export class RequestDataExport {
  constructor(private readonly deps: GdprDependencies) {}

  /** A new export, or the one that waits or runs already. */
  async execute(actor: OrganizationActor): Promise<GdprRequest> {
    assertOwner(actor);
    const now = this.deps.clock.now();
    const request = await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const open = await store.requests.findOpen(actor.organizationId, 'EXPORT');
      if (open) {
        return open;
      }
      const created: GdprRequest = {
        id: this.deps.ids.newId(),
        organizationId: actor.organizationId,
        kind: 'EXPORT',
        status: 'PENDING',
        requestedById: actor.userId,
        runAfter: now,
        startedAt: null,
        completedAt: null,
        objectKey: null,
        expiresAt: null,
        details: {},
        createdAt: now,
      };
      if (!(await store.requests.create(created))) {
        // A parallel call was faster; its export is the one.
        const parallel = await store.requests.findOpen(actor.organizationId, 'EXPORT');
        if (parallel) {
          return parallel;
        }
        throw new Error('An export of the organization was created and finished at the same time.');
      }
      await store.audit.record({
        organizationId: actor.organizationId,
        action: 'gdpr.export_requested',
        targetType: 'GdprRequest',
        targetId: created.id,
      });
      return created;
    });
    // Queued again for an export that waits, in case its job was lost: the request id keeps it one job.
    if (request.status === 'PENDING') {
      await this.deps.jobs.exportData(request.id);
    }
    return request;
  }
}

export class ListDataExports {
  constructor(private readonly deps: Pick<GdprDependencies, 'unitOfWork'>) {}

  async execute(actor: OrganizationActor): Promise<GdprRequest[]> {
    assertOwner(actor);
    return await this.deps.unitOfWork.run(scopeOf(actor), (store) =>
      store.requests.listRecent(actor.organizationId, 'EXPORT', LISTED_EXPORTS),
    );
  }
}

export class DownloadDataExport {
  constructor(
    private readonly deps: Pick<GdprDependencies, 'unitOfWork' | 'clock'> & {
      storage: Pick<StoragePort, 'signedGetUrl'>;
    },
  ) {}

  /** A link to the archive of a finished export that lasts a few minutes. */
  async execute(actor: OrganizationActor, requestId: string): Promise<{ url: string; expiresAt: Date }> {
    assertOwner(actor);
    const now = this.deps.clock.now();
    const objectKey = await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const request = await store.requests.find(actor.organizationId, requestId);
      if (!request?.objectKey || !request.completedAt || !isDownloadable(request, now)) {
        throw new DataExportUnavailableError();
      }
      await store.audit.record({
        organizationId: actor.organizationId,
        action: 'gdpr.export_downloaded',
        targetType: 'GdprRequest',
        targetId: request.id,
      });
      return { key: request.objectKey, completedAt: request.completedAt };
    });
    const url = await this.deps.storage.signedGetUrl(objectKey.key, {
      expiresInSeconds: DOWNLOAD_LINK_SECONDS,
      downloadName: exportFileNameOf(objectKey.completedAt),
    });
    return { url, expiresAt: new Date(now.getTime() + DOWNLOAD_LINK_SECONDS * 1000) };
  }
}
