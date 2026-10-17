import { limitOverridesSchema, planKeySchema, planLimitsSchema } from '@smp/contracts';
import type { Plan, Subscription, SubscriptionReader, TrialStarter } from '@smp/core';

import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { withTenantTx, type TenantTransaction } from '../tenant-context';

// The subscriptions of billing on PostgreSQL (guide step 7.1). The limits are JSON; they are
// checked against @smp/contracts whenever they are read, so a broken row fails loudly instead of
// granting something. app_user reads in the context of the organization; it may only add the
// trial of a new organization (row-level security, migration 0018).

type PlanRow = Prisma.PlanGetPayload<object>;
type SubscriptionRow = Prisma.SubscriptionGetPayload<{ include: { plan: true } }>;

export function toPlan(row: PlanRow): Plan {
  return {
    key: planKeySchema.parse(row.key),
    limits: planLimitsSchema.parse(row.limits),
    priceLookupKey: row.priceLookupKey,
    position: row.position,
    active: row.active,
  };
}

export function toSubscription(row: SubscriptionRow): Subscription {
  return {
    organizationId: row.organizationId,
    plan: toPlan(row.plan),
    status: row.status,
    limitOverrides: row.limitOverrides === null ? null : limitOverridesSchema.parse(row.limitOverrides),
    trialEndsAt: row.trialEndsAt,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    pastDueSince: row.pastDueSince,
    readOnlyAt: row.readOnlyAt,
    billingStartedAt: row.billingStartedAt,
  };
}

/** The trial of a new organization, in the transaction of the tenancy unit of work. */
export const prismaTrialStarter = (tx: TenantTransaction): TrialStarter => ({
  async startTrial(trial) {
    await tx.subscription.create({
      data: {
        id: trial.id,
        organizationId: trial.organizationId,
        planKey: 'trial',
        status: 'TRIALING',
        trialEndsAt: trial.trialEndsAt,
        readOnlyAt: trial.readOnlyAt,
      },
    });
  },
});

export class PrismaSubscriptionReader implements SubscriptionReader {
  constructor(private readonly base: PrismaClient) {}

  find(organizationId: string): Promise<Subscription | null> {
    return withTenantTx(this.base, { organizationId }, async (tx) => {
      const row = await tx.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
      return row ? toSubscription(row) : null;
    });
  }

  async plans(): Promise<Plan[]> {
    const rows = await this.base.plan.findMany({ orderBy: { position: 'asc' } });
    return rows.map(toPlan);
  }
}
