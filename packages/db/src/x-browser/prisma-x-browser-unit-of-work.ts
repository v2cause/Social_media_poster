import type { XBrowserScope, XBrowserStore, XBrowserUnitOfWork } from '@smp/core';

import type { RequestOrigin } from '../audit/prisma-audit-trail';
import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';
import { createPrismaXBrowserStore } from './prisma-x-browser-store';

/** XBrowserUnitOfWork on PostgreSQL: one interactive transaction per run, scope set at its start. */
export class PrismaXBrowserUnitOfWork implements XBrowserUnitOfWork {
  constructor(
    private readonly base: PrismaClient,
    private readonly origin: () => RequestOrigin = () => ({}),
  ) {}

  run<T>(scope: XBrowserScope, work: (store: XBrowserStore) => Promise<T>): Promise<T> {
    const origin = this.origin();
    return withTenantTx(this.base, scope, (tx) => work(createPrismaXBrowserStore(tx, scope, origin)));
  }
}
