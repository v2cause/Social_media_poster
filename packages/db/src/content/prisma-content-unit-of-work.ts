import type { ContentScope, ContentStore, ContentUnitOfWork } from '@smp/core';

import type { RequestOrigin } from '../audit/prisma-audit-trail';
import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';
import { createPrismaContentStore } from './prisma-content-store';

/** ContentUnitOfWork on PostgreSQL: one interactive transaction per run, scope set at its start. */
export class PrismaContentUnitOfWork implements ContentUnitOfWork {
  constructor(
    private readonly base: PrismaClient,
    private readonly origin: () => RequestOrigin = () => ({}),
  ) {}

  run<T>(scope: ContentScope, work: (store: ContentStore) => Promise<T>): Promise<T> {
    const origin = this.origin();
    return withTenantTx(this.base, scope, (tx) => work(createPrismaContentStore(tx, scope, origin)));
  }
}
