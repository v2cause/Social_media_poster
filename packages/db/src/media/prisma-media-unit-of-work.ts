import type { MediaScope, MediaStore, MediaUnitOfWork } from '@smp/core';

import type { RequestOrigin } from '../audit/prisma-audit-trail';
import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';
import { createPrismaMediaStore } from './prisma-media-store';

/**
 * MediaUnitOfWork on PostgreSQL: one interactive transaction per run, scope set at its start.
 * Jobs of the worker run without a user; the audit log then names no actor.
 */
export class PrismaMediaUnitOfWork implements MediaUnitOfWork {
  constructor(
    private readonly base: PrismaClient,
    private readonly origin: () => RequestOrigin = () => ({}),
  ) {}

  run<T>(scope: MediaScope, work: (store: MediaStore) => Promise<T>): Promise<T> {
    const origin = this.origin();
    const context = {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      ...(scope.userId === null ? {} : { userId: scope.userId }),
    };
    return withTenantTx(this.base, context, (tx) => work(createPrismaMediaStore(tx, scope, origin)));
  }
}
