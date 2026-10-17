import type { PlanKey } from './plan';
import { readOnlyAtOf, type SubscriptionStatus } from './subscription';

// How billing takes over the state of a paid subscription (guide step 7.2, ADR 0034). The role
// "billing" reads the subscription from Stripe after every webhook and lets this decide what
// changes; the webhook itself only says that something happened.

/** What billing keeps of a subscription. */
export interface BillingState {
  planKey: PlanKey;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: Date | null;
  readOnlyAt: Date | null;
  billingStartedAt: Date | null;
}

/** A subscription as the provider reports it, its plan found by the lookup key of its price. */
export interface ReportedSubscription {
  id: string;
  status: SubscriptionStatus;
  /** Null when no plan of the price list has the price. */
  planKey: PlanKey | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  startedAt: Date;
  trialEnd: Date | null;
}

export type SyncOutcome =
  | { kind: 'changed'; state: BillingState; pastDueStarted: boolean }
  /** A checkout that did not go through, or a subscription other than the one in force. */
  | { kind: 'ignored'; reason: 'not_started' | 'other_subscription' };

const RUNNING: readonly SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

/**
 * The state after the provider reported a subscription. A subscription that never started leaves
 * the organization as it was, for example on its trial. Another subscription than the one in
 * force takes over only while it runs and the one in force does not, so a late report of an old
 * subscription changes nothing. An overdue payment keeps the start of its grace period, and an
 * organization that is read-only already keeps the moment it became so.
 */
export function syncSubscription(
  previous: BillingState,
  reported: ReportedSubscription,
  now: Date,
): SyncOutcome {
  const same = previous.stripeSubscriptionId === reported.id;
  if (!same) {
    if (!RUNNING.includes(reported.status)) {
      return {
        kind: 'ignored',
        reason:
          reported.status === 'INCOMPLETE' || reported.status === 'INCOMPLETE_EXPIRED'
            ? 'not_started'
            : 'other_subscription',
      };
    }
    if (previous.stripeSubscriptionId !== null && RUNNING.includes(previous.status)) {
      return { kind: 'ignored', reason: 'other_subscription' };
    }
  }
  const wasPastDue = same && previous.status === 'PAST_DUE';
  const pastDueSince =
    reported.status === 'PAST_DUE' ? (wasPastDue ? (previous.pastDueSince ?? now) : now) : null;
  const state: BillingState = {
    planKey: reported.planKey ?? previous.planKey,
    status: reported.status,
    trialEndsAt: reported.trialEnd,
    stripeSubscriptionId: reported.id,
    currentPeriodStart: reported.currentPeriodStart,
    currentPeriodEnd: reported.currentPeriodEnd,
    cancelAtPeriodEnd: reported.cancelAtPeriodEnd,
    pastDueSince,
    readOnlyAt: readOnlyAtOf(
      {
        status: reported.status,
        trialEndsAt: reported.trialEnd,
        pastDueSince,
        stripeSubscriptionId: reported.id,
      },
      previous.readOnlyAt,
      now,
    ),
    billingStartedAt: same ? (previous.billingStartedAt ?? reported.startedAt) : reported.startedAt,
  };
  return { kind: 'changed', state, pastDueStarted: reported.status === 'PAST_DUE' && !wasPastDue };
}
