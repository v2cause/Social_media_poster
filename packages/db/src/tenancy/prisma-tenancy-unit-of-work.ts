import type { TenancyScope, TenancyStore, TenancyUnitOfWork } from '@smp/core';

import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';
import { createPrismaTenancyStore, type RequestOrigin } from './prisma-tenancy-store';

/** TenancyUnitOfWork on PostgreSQL: one interactive transaction per run, scope set at its start. */
export class PrismaTenancyUnitOfWork implements TenancyUnitOfWork {
  constructor(
    private readonly base: PrismaClient,
    private readonly origin: () => RequestOrigin = () => ({}),
  ) {}

  run<T>(scope: TenancyScope, work: (store: TenancyStore) => Promise<T>): Promise<T> {
    const origin = this.origin();
    return withTenantTx(this.base, scope, (tx) => work(createPrismaTenancyStore(tx, scope, origin)));
  }
}
