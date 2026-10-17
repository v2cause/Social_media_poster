import type { BillingOverviewDto, BillingStateDto, PlanKey, PlanLimits } from '@smp/contracts';

// What the billing page and the app shell show of the subscription (guide steps 7.4 and 7.5): a
// bar per limit with its state, what a change of plan would leave beyond the limits of the new
// plan, the action each plan offers, and the notice every member sees.

export type UsageKey =
  'workspaces' | 'members' | 'socialAccounts' | 'scheduledPosts' | 'storageBytes' | 'ai' | 'xApi';

export type UsageUnit = 'count' | 'bytes' | 'micros';

/**
 * ok and near (from 80 percent) leave room; full allows nothing new; over is beyond the limit,
 * after a downgrade: what exists stays, nothing new comes, and the page asks to reduce it.
 */
export type UsageState = 'ok' | 'near' | 'full' | 'over';

export interface UsageRow {
  key: UsageKey;
  unit: UsageUnit;
  used: number;
  limit: number;
  /** The width of the bar, 0 to 100. */
  percent: number;
  state: UsageState;
  /** Counted in the calendar month (UTC), not in total. */
  monthly: boolean;
  /** The AI usage the plan includes; beyond it up to the limit the meter bills the overage. */
  included?: number;
}

const NEAR = 0.8;

function stateOf(used: number, limit: number): UsageState {
  if (used > limit) {
    return 'over';
  }
  if (used === limit) {
    return 'full';
  }
  return used >= limit * NEAR ? 'near' : 'ok';
}

const percentOf = (used: number, limit: number): number =>
  limit <= 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));

const row = (
  key: UsageKey,
  unit: UsageUnit,
  usage: { used: number; limit: number },
  monthly = false,
): UsageRow => ({
  key,
  unit,
  used: usage.used,
  limit: usage.limit,
  percent: percentOf(usage.used, usage.limit),
  state: stateOf(usage.used, usage.limit),
  monthly,
});

/** One bar per limit, in the order of the page. */
export function usageRowsOf(overview: BillingOverviewDto): UsageRow[] {
  const { usage } = overview;
  const aiLimit = usage.ai.includedMicros + usage.ai.overageCapMicros;
  return [
    row('workspaces', 'count', usage.workspaces),
    row('members', 'count', usage.members),
    row('socialAccounts', 'count', usage.socialAccounts),
    row('scheduledPosts', 'count', usage.scheduledPosts, true),
    row('storageBytes', 'bytes', usage.storageBytes),
    {
      ...row('ai', 'micros', { used: usage.ai.usedMicros, limit: aiLimit }, true),
      // The overage is billed, not beyond the limit; the plan stops at credits plus overage.
      state: usage.ai.usedMicros >= aiLimit ? 'full' : usage.ai.usedMicros >= aiLimit * NEAR ? 'near' : 'ok',
      included: usage.ai.includedMicros,
    },
    row('xApi', 'micros', usage.xApiMicros, true),
  ];
}

/** The resources a plan with these limits would have too many of; what exists stays then. */
export function beyondLimitsOf(overview: BillingOverviewDto, limits: PlanLimits): UsageRow[] {
  const { usage } = overview;
  const candidates = [
    row('workspaces', 'count', { used: usage.workspaces.used, limit: limits.maxWorkspaces }),
    row('members', 'count', { used: usage.members.used, limit: limits.maxMembers }),
    row('socialAccounts', 'count', { used: usage.socialAccounts.used, limit: limits.maxSocialAccounts }),
    row(
      'scheduledPosts',
      'count',
      { used: usage.scheduledPosts.used, limit: limits.scheduledPostsPerMonth },
      true,
    ),
    row('storageBytes', 'bytes', { used: usage.storageBytes.used, limit: limits.storageBytes }),
  ];
  return candidates.filter((candidate) => candidate.state === 'over');
}

/**
 * What a plan offers: it is the running one, a checkout (no paid subscription runs), a change in
 * place (one runs), or nothing while Stripe is not set up or the plan has no price.
 */
export type PlanAction = 'current' | 'checkout' | 'change' | 'unavailable';

export function planActionOf(overview: BillingOverviewDto, key: PlanKey): PlanAction {
  const running = overview.hasRunningSubscription || overview.status === 'TRIALING';
  if (key === overview.plan.key && running && overview.access === 'full') {
    return 'current';
  }
  const plan = overview.plans.find((entry) => entry.key === key);
  if (!overview.billingEnabled || !plan?.price) {
    return 'unavailable';
  }
  return overview.hasRunningSubscription ? 'change' : 'checkout';
}

/** The plans an owner can buy or change to, in the order of the price list. */
export const offeredPlansOf = (overview: BillingOverviewDto) =>
  overview.plans.filter((plan) => plan.key !== 'trial');

/** A trial that ends within these days gets a notice. */
const TRIAL_NOTICE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type BillingNotice =
  | { kind: 'read_only' }
  | { kind: 'past_due'; graceEndsAt: string }
  | { kind: 'trial_ending'; trialEndsAt: string };

/** The notice of the app shell, or null while the subscription needs nothing. */
export function noticeOf(state: BillingStateDto, now: Date): BillingNotice | null {
  if (state.access === 'read_only') {
    return { kind: 'read_only' };
  }
  if (state.status === 'PAST_DUE' && state.graceEndsAt) {
    return { kind: 'past_due', graceEndsAt: state.graceEndsAt };
  }
  if (
    state.status === 'TRIALING' &&
    state.trialEndsAt &&
    Date.parse(state.trialEndsAt) - now.getTime() <= TRIAL_NOTICE_DAYS * DAY_MS
  ) {
    return { kind: 'trial_ending', trialEndsAt: state.trialEndsAt };
  }
  return null;
}

/** An amount in the minor unit of its currency, as Stripe has it, in the major unit. */
export function fromMinorUnits(amount: number, currency: string): number {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return amount / 10 ** digits;
}

export type ByteUnit = 'gigabyte' | 'megabyte' | 'kilobyte';

/** Bytes in the largest unit that keeps the value at 1 or more, counted in 1024 like the limits. */
export function bytesIn(bytes: number): { value: number; unit: ByteUnit } {
  if (bytes >= 1024 ** 3) {
    return { value: bytes / 1024 ** 3, unit: 'gigabyte' };
  }
  if (bytes >= 1024 ** 2) {
    return { value: bytes / 1024 ** 2, unit: 'megabyte' };
  }
  return { value: Math.ceil(bytes / 1024), unit: 'kilobyte' };
}
