import type { PublishJobScope, PublishJobStore, PublishJobUnitOfWork } from '@smp/core';

import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';
import { createPrismaPublishJobStore } from './prisma-publish-job-store';

/**
 * PublishJobUnitOfWork on PostgreSQL: one interactive transaction per run, the tenant of the job
 * set at its start. Jobs act without a user.
 */
export class PrismaPublishJobUnitOfWork implements PublishJobUnitOfWork {
  constructor(private readonly base: PrismaClient) {}

  run<T>(scope: PublishJobScope, work: (store: PublishJobStore) => Promise<T>): Promise<T> {
    return withTenantTx(
      this.base,
      { organizationId: scope.organizationId, workspaceId: scope.workspaceId },
      (tx) => work(createPrismaPublishJobStore(tx)),
    );
  }
}
