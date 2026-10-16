import type { ChannelScope, ChannelStore, ChannelUnitOfWork } from '@smp/core';

import type { RequestOrigin } from '../audit/prisma-audit-trail';
import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';
import { createPrismaChannelStore } from './prisma-channel-store';

/** ChannelUnitOfWork on PostgreSQL: one interactive transaction per run, scope set at its start. */
export class PrismaChannelUnitOfWork implements ChannelUnitOfWork {
  constructor(
    private readonly base: PrismaClient,
    private readonly origin: () => RequestOrigin = () => ({}),
  ) {}

  run<T>(scope: ChannelScope, work: (store: ChannelStore) => Promise<T>): Promise<T> {
    const origin = this.origin();
    return withTenantTx(this.base, scope, (tx) => work(createPrismaChannelStore(tx, scope, origin)));
  }
}
