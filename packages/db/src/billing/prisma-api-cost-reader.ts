import type { PlanUsage } from '@smp/core';

import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';

// The X API costs of an organization in a month, as app_user in its tenant: the cost ledger is
// keyed by organization, so the workers that call X check the spending cap of the plan without
// app_system (guide step 7.4).

export class PrismaApiCostReader implements Pick<PlanUsage, 'xApiSpendMicros'> {
  constructor(private readonly base: PrismaClient) {}

  xApiSpendMicros(organizationId: string, at: Date): Promise<number> {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
    return withTenantTx(this.base, { organizationId }, async (tx) => {
      const { _sum } = await tx.apiCostRecord.aggregate({
        where: { organizationId, platform: 'X', createdAt: { gte: start, lt: end } },
        _sum: { costMicros: true },
      });
      return Number(_sum.costMicros ?? 0n);
    });
  }
}
