import type { PlanLimits } from '../domain/plan';
import type { Subscription, SubscriptionReader } from '../ports/subscription-store';

// The single-user mode (ADR 0046): one person runs the app on their own machine, so there is no
// trial, no payment and no limit. Every organization reads as an active subscription of the most
// generous plan, with limits no one reaches. All checks (read-only, quotas, counts) stay in place
// and simply pass. The numbers are large but finite, so date and quota arithmetic stays valid.

export const LOCAL_MODE_LIMITS: Omit<PlanLimits, 'xBrowserAllowed'> = {
  maxWorkspaces: 1_000,
  maxSocialAccounts: 10_000,
  maxMembers: 1_000,
  aiCreditsMicros: 1_000_000_000_000_000,
  aiOverageCapMicros: 0,
  scheduledPostsPerMonth: 1_000_000,
  storageBytes: 1_000_000_000_000_000,
  analyticsHistoryDays: 36_500,
  xApiSpendCapMicros: 1_000_000_000_000_000,
};

export class LocalModeSubscriptionReader implements SubscriptionReader {
  constructor(private readonly inner: SubscriptionReader) {}

  plans(): ReturnType<SubscriptionReader['plans']> {
    return this.inner.plans();
  }

  async find(organizationId: string): Promise<Subscription> {
    const plans = (await this.inner.plans()).filter((plan) => plan.active);
    const plan = plans.find((entry) => entry.key === 'agency') ?? plans.at(-1);
    if (!plan) {
      throw new Error('The price list has no active plan.');
    }
    return {
      organizationId,
      plan,
      status: 'ACTIVE',
      limitOverrides: LOCAL_MODE_LIMITS,
      trialEndsAt: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      pastDueSince: null,
      readOnlyAt: null,
      billingStartedAt: null,
    };
  }
}
