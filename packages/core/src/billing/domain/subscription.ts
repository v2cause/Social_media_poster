// The subscription of an organization and what follows from its state (guide step 7.4, ADR 0033):
// a new organization tries the product for 14 days; an overdue payment leaves 7 days of grace;
// after that, and once a subscription has ended, the organization is read-only until it pays.

export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'UNPAID',
  'INCOMPLETE',
  'INCOMPLETE_EXPIRED',
  'PAUSED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;

/** The trial of a new organization: read-only from its end on, unless a plan was bought. */
export function trialFrom(now: Date): { trialEndsAt: Date; readOnlyAt: Date } {
  const end = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
  return { trialEndsAt: end, readOnlyAt: end };
}

/** The end of the grace period of an overdue payment. */
export const graceEndOf = (pastDueSince: Date): Date =>
  new Date(pastDueSince.getTime() + GRACE_DAYS * DAY_MS);

/** The part of a subscription that decides from when the organization is read-only. */
export interface AccessState {
  status: SubscriptionStatus;
  /** The trial of the organization itself. */
  trialEndsAt: Date | null;
  pastDueSince: Date | null;
  /** A paid subscription; Stripe ends its trials itself, with a webhook. */
  stripeSubscriptionId: string | null;
}

/**
 * From when an organization is read-only, or null while it may write: the end of the trial, the
 * end of the grace period of an overdue payment, at once for a subscription that ended, was not
 * paid or never started. An organization that is read-only already keeps the moment it became
 * so, however often the state is copied again.
 */
export function readOnlyAtOf(state: AccessState, previousReadOnlyAt: Date | null, now: Date): Date | null {
  let at: Date | null;
  switch (state.status) {
    case 'ACTIVE':
      at = null;
      break;
    case 'TRIALING':
      at = state.stripeSubscriptionId === null ? state.trialEndsAt : null;
      break;
    case 'PAST_DUE':
      at = graceEndOf(state.pastDueSince ?? now);
      break;
    case 'CANCELED':
    case 'UNPAID':
    case 'INCOMPLETE':
    case 'INCOMPLETE_EXPIRED':
    case 'PAUSED':
      at = now;
      break;
  }
  if (at !== null && at <= now && previousReadOnlyAt !== null && previousReadOnlyAt <= now) {
    return previousReadOnlyAt;
  }
  return at;
}

/** Whether an organization is read-only at a moment. */
export const isReadOnlyAt = (readOnlyAt: Date | null, now: Date): boolean =>
  readOnlyAt !== null && readOnlyAt.getTime() <= now.getTime();
