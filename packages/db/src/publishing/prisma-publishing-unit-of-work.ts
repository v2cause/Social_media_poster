import type { PublishingScope, PublishingStore, PublishingUnitOfWork } from '@smp/core';

import type { RequestOrigin } from '../audit/prisma-audit-trail';
import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';
import { createPrismaPublishingStore } from './prisma-publishing-store';

/** PublishingUnitOfWork on PostgreSQL: one interactive transaction per run, scope set at its start. */
export class PrismaPublishingUnitOfWork implements PublishingUnitOfWork {
  constructor(
    private readonly base: PrismaClient,
    private readonly origin: () => RequestOrigin = () => ({}),
  ) {}

  run<T>(scope: PublishingScope, work: (store: PublishingStore) => Promise<T>): Promise<T> {
    const origin = this.origin();
    return withTenantTx(this.base, scope, (tx) => work(createPrismaPublishingStore(tx, scope, origin)));
  }
}
