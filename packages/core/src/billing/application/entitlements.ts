import type { Clock } from '../../shared/ports/clock';
import { SubscriptionInactiveError } from '../domain/errors';
import { assertWithinLimit } from '../domain/limits';
import { effectiveLimits, type CountedLimit, type Plan, type PlanLimits } from '../domain/plan';
import { graceEndOf, isReadOnlyAt, type SubscriptionStatus } from '../domain/subscription';
import type { Subscription, SubscriptionReader } from '../ports/subscription-store';

// What an organization may do under its subscription (guide steps 7.2 and 7.4, ADR 0033): the
// limits of its plan with the overrides of the operators, and whether it may write at all. The
// API reads the subscription with every change, so a webhook takes effect with the next request;
// a caller that asks often, like a gate of the worker, may keep it in memory for a few seconds.

export interface Entitlements {
  organizationId: string;
  plan: Plan;
  limits: PlanLimits;
  status: SubscriptionStatus;
  /** Read-only now: the trial or the grace period ended, or the subscription did. */
  readOnly: boolean;
  readOnlyAt: Date | null;
  trialEndsAt: Date | null;
  /** While a payment is overdue: from then on the organization is read-only. */
  graceEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

export interface EntitlementsDependencies {
  subscriptions: SubscriptionReader;
  clock: Clock;
  /** How long a subscription stays in memory; 0 reads it every time. */
  cacheMs?: number;
}

export class EntitlementsService {
  private readonly cache = new Map<string, { until: number; subscription: Subscription }>();

  constructor(private readonly deps: EntitlementsDependencies) {}

  async of(organizationId: string): Promise<Entitlements> {
    const subscription = await this.subscription(organizationId);
    const now = this.deps.clock.now();
    return {
      organizationId,
      plan: subscription.plan,
      limits: effectiveLimits(subscription.plan.limits, subscription.limitOverrides),
      status: subscription.status,
      readOnly: isReadOnlyAt(subscription.readOnlyAt, now),
      readOnlyAt: subscription.readOnlyAt,
      trialEndsAt: subscription.trialEndsAt,
      graceEndsAt:
        subscription.status === 'PAST_DUE' && subscription.pastDueSince !== null
          ? graceEndOf(subscription.pastDueSince)
          : null,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      stripeCustomerId: subscription.stripeCustomerId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
    };
  }

  /** Throws SubscriptionInactiveError while the organization is read-only. */
  async assertWritable(organizationId: string): Promise<Entitlements> {
    const entitlements = await this.of(organizationId);
    if (entitlements.readOnly) {
      throw new SubscriptionInactiveError();
    }
    return entitlements;
  }

  /**
   * Throws PlanLimitReachedError when adding to what is used goes beyond the limit. Only new
   * resources are checked: after a downgrade, what exists stays.
   */
  async assertWithin(organizationId: string, limit: CountedLimit, used: number, adding = 1): Promise<void> {
    assertWithinLimit((await this.of(organizationId)).limits, limit, used, adding);
  }

  /** Forgets what this process remembers of an organization, after it changed the subscription. */
  forget(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  private async subscription(organizationId: string): Promise<Subscription> {
    const cacheMs = this.deps.cacheMs ?? 0;
    const now = this.deps.clock.now().getTime();
    const cached = this.cache.get(organizationId);
    if (cached && cached.until > now) {
      return cached.subscription;
    }
    const subscription =
      (await this.deps.subscriptions.find(organizationId)) ?? (await this.trialWithoutEnd(organizationId));
    if (cacheMs > 0) {
      this.cache.set(organizationId, { until: now + cacheMs, subscription });
    }
    return subscription;
  }

  /** Every organization gets its subscription when it is created; one from before has the trial. */
  private async trialWithoutEnd(organizationId: string): Promise<Subscription> {
    const plan = (await this.deps.subscriptions.plans()).find((entry) => entry.key === 'trial');
    if (!plan) {
      throw new Error('The price list has no trial plan.');
    }
    return {
      organizationId,
      plan,
      status: 'TRIALING',
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
    };
  }
}
