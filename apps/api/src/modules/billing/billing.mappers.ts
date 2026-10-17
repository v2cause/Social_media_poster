import type { BillingStateDto } from '@smp/contracts';
import type { BillingOverview, Entitlements, PlanPrice } from '@smp/core';

import type { BillingOverviewDto } from './billing.dto';

// The overview of the core to the response of the billing page (guide step 7.5): timestamps as
// ISO strings, every limit with what the organization uses of it. The current plan carries the
// limits with the overrides of the operators, the plans to compare those of the price list.

const isoOf = (date: Date | null): string | null => date?.toISOString() ?? null;

const priceOf = (price: PlanPrice | null): BillingOverviewDto['plan']['price'] =>
  price ? { unitAmount: price.unitAmount, currency: price.currency, interval: price.interval } : null;

/** What every member sees of the subscription, in the contexts the app shell loads. */
export const toBillingStateDto = (entitlements: Entitlements): BillingStateDto => ({
  access: entitlements.readOnly ? 'read_only' : 'full',
  status: entitlements.status,
  trialEndsAt: isoOf(entitlements.trialEndsAt),
  graceEndsAt: isoOf(entitlements.graceEndsAt),
});

export function toBillingOverviewDto(overview: BillingOverview): BillingOverviewDto {
  const { entitlements, usage } = overview;
  const { limits } = entitlements;
  const current = overview.plans.find(({ plan }) => plan.key === entitlements.plan.key);
  return {
    plan: { key: entitlements.plan.key, limits, price: priceOf(current?.price ?? null) },
    status: entitlements.status,
    access: entitlements.readOnly ? 'read_only' : 'full',
    trialEndsAt: isoOf(entitlements.trialEndsAt),
    graceEndsAt: isoOf(entitlements.graceEndsAt),
    readOnlySince: entitlements.readOnly ? isoOf(entitlements.readOnlyAt) : null,
    currentPeriodEnd: isoOf(entitlements.currentPeriodEnd),
    cancelAtPeriodEnd: entitlements.cancelAtPeriodEnd,
    billingEnabled: overview.billingEnabled,
    hasRunningSubscription: overview.hasRunningSubscription,
    hasCustomer: entitlements.stripeCustomerId !== null,
    periodStart: overview.periodStart.toISOString().slice(0, 10),
    usage: {
      workspaces: { used: usage.workspaces, limit: limits.maxWorkspaces },
      socialAccounts: { used: usage.socialAccounts, limit: limits.maxSocialAccounts },
      members: { used: usage.members, limit: limits.maxMembers },
      scheduledPosts: { used: usage.scheduledPosts, limit: limits.scheduledPostsPerMonth },
      storageBytes: { used: usage.storageBytes, limit: limits.storageBytes },
      xApiMicros: { used: usage.xApiMicros, limit: limits.xApiSpendCapMicros },
      ai: {
        usedMicros: usage.aiMicros,
        includedMicros: limits.aiCreditsMicros,
        overageCapMicros: limits.aiOverageCapMicros,
      },
    },
    plans: overview.plans.map(({ plan, price }) => ({
      key: plan.key,
      limits: plan.limits,
      price: priceOf(price),
    })),
  };
}
