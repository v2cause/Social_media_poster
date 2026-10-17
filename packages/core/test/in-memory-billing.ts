import type { Plan, Subscription, SubscriptionReader, TrialStarter } from '../src';

// The price list of migration 0018 and an in-memory store of subscriptions for the use cases of
// billing.

export const TEST_PLANS: Plan[] = [
  {
    key: 'trial',
    priceLookupKey: null,
    position: 0,
    active: true,
    limits: {
      maxWorkspaces: 1,
      maxSocialAccounts: 3,
      maxMembers: 3,
      aiCreditsMicros: 2_000_000,
      aiOverageCapMicros: 0,
      scheduledPostsPerMonth: 30,
      storageBytes: 1024 ** 3,
      analyticsHistoryDays: 30,
      xBrowserAllowed: false,
      xApiSpendCapMicros: 1_000_000,
    },
  },
  {
    key: 'starter',
    priceLookupKey: 'smp_starter_monthly',
    position: 1,
    active: true,
    limits: {
      maxWorkspaces: 1,
      maxSocialAccounts: 5,
      maxMembers: 3,
      aiCreditsMicros: 10_000_000,
      aiOverageCapMicros: 10_000_000,
      scheduledPostsPerMonth: 150,
      storageBytes: 5 * 1024 ** 3,
      analyticsHistoryDays: 90,
      xBrowserAllowed: false,
      xApiSpendCapMicros: 10_000_000,
    },
  },
  {
    key: 'pro',
    priceLookupKey: 'smp_pro_monthly',
    position: 2,
    active: true,
    limits: {
      maxWorkspaces: 3,
      maxSocialAccounts: 15,
      maxMembers: 10,
      aiCreditsMicros: 30_000_000,
      aiOverageCapMicros: 50_000_000,
      scheduledPostsPerMonth: 600,
      storageBytes: 25 * 1024 ** 3,
      analyticsHistoryDays: 365,
      xBrowserAllowed: true,
      xApiSpendCapMicros: 50_000_000,
    },
  },
  {
    key: 'agency',
    priceLookupKey: 'smp_agency_monthly',
    position: 3,
    active: true,
    limits: {
      maxWorkspaces: 15,
      maxSocialAccounts: 75,
      maxMembers: 50,
      aiCreditsMicros: 100_000_000,
      aiOverageCapMicros: 200_000_000,
      scheduledPostsPerMonth: 3_000,
      storageBytes: 100 * 1024 ** 3,
      analyticsHistoryDays: 730,
      xBrowserAllowed: true,
      xApiSpendCapMicros: 200_000_000,
    },
  },
];

export const planOf = (key: Plan['key']): Plan => {
  const plan = TEST_PLANS.find((entry) => entry.key === key);
  if (!plan) {
    throw new Error(`No plan ${key}`);
  }
  return plan;
};

/** A subscription on a plan, active and without Stripe unless the patch says otherwise. */
export const subscriptionOf = (
  organizationId: string,
  key: Plan['key'],
  patch: Partial<Subscription> = {},
): Subscription => ({
  organizationId,
  plan: planOf(key),
  status: 'ACTIVE',
  limitOverrides: null,
  trialEndsAt: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  readOnlyAt: null,
  billingStartedAt: null,
  ...patch,
});

export class MemorySubscriptions implements SubscriptionReader, TrialStarter {
  readonly rows = new Map<string, Subscription>();
  reads = 0;

  find(organizationId: string): Promise<Subscription | null> {
    this.reads += 1;
    return Promise.resolve(this.rows.get(organizationId) ?? null);
  }

  plans(): Promise<Plan[]> {
    return Promise.resolve(TEST_PLANS);
  }

  startTrial(trial: {
    id: string;
    organizationId: string;
    trialEndsAt: Date;
    readOnlyAt: Date;
  }): Promise<void> {
    this.rows.set(
      trial.organizationId,
      subscriptionOf(trial.organizationId, 'trial', {
        status: 'TRIALING',
        trialEndsAt: trial.trialEndsAt,
        readOnlyAt: trial.readOnlyAt,
      }),
    );
    return Promise.resolve();
  }

  put(subscription: Subscription): void {
    this.rows.set(subscription.organizationId, subscription);
  }
}
