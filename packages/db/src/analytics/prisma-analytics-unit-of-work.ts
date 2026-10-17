import type { AnalyticsScope, AnalyticsStore, AnalyticsUnitOfWork } from '@smp/core';

import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';
import { createPrismaAnalyticsStore } from './prisma-analytics-store';

/**
 * AnalyticsUnitOfWork on PostgreSQL: one interactive transaction per unit, the tenant of the job
 * set at its start. Jobs act without a user.
 */
export class PrismaAnalyticsUnitOfWork implements AnalyticsUnitOfWork {
  constructor(private readonly base: PrismaClient) {}

  run<T>(scope: AnalyticsScope, work: (store: AnalyticsStore) => Promise<T>): Promise<T> {
    return withTenantTx(
      this.base,
      { organizationId: scope.organizationId, workspaceId: scope.workspaceId },
      (tx) => work(createPrismaAnalyticsStore(tx)),
    );
  }
}
