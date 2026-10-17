import type { BillingOverviewDto, PlanLimits } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import {
  beyondLimitsOf,
  bytesIn,
  fromMinorUnits,
  noticeOf,
  offeredPlansOf,
  planActionOf,
  usageRowsOf,
} from './billing-model';

const STARTER: PlanLimits = {
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
};
const PRO: PlanLimits = {
  ...STARTER,
  maxWorkspaces: 3,
  maxSocialAccounts: 15,
  maxMembers: 10,
  scheduledPostsPerMonth: 600,
};
const price = (unitAmount: number) => ({ unitAmount, currency: 'eur', interval: 'month' as const });

const overview = (patch: Partial<BillingOverviewDto> = {}): BillingOverviewDto => ({
  plan: { key: 'pro', limits: PRO, price: price(4_900) },
  status: 'ACTIVE',
  access: 'full',
  trialEndsAt: null,
  graceEndsAt: null,
  readOnlySince: null,
  currentPeriodEnd: '2026-11-17T12:00:00.000Z',
  cancelAtPeriodEnd: false,
  billingEnabled: true,
  hasRunningSubscription: true,
  hasCustomer: true,
  periodStart: '2026-10-01',
  usage: {
    workspaces: { used: 2, limit: 3 },
    socialAccounts: { used: 12, limit: 15 },
    members: { used: 10, limit: 10 },
    scheduledPosts: { used: 140, limit: 600 },
    storageBytes: { used: 1024 ** 3, limit: 25 * 1024 ** 3 },
    xApiMicros: { used: 0, limit: 50_000_000 },
    ai: { usedMicros: 35_000_000, includedMicros: 30_000_000, overageCapMicros: 50_000_000 },
  },
  plans: [
    { key: 'trial', limits: STARTER, price: null },
    { key: 'starter', limits: STARTER, price: price(1_900) },
    { key: 'pro', limits: PRO, price: price(4_900) },
    { key: 'agency', limits: PRO, price: null },
  ],
  ...patch,
});

describe('usageRowsOf', () => {
  it('gives every limit a bar with its state', () => {
    const rows = usageRowsOf(overview());
    expect(rows.map((row) => [row.key, row.percent, row.state])).toEqual([
      ['workspaces', 67, 'ok'],
      ['members', 100, 'full'],
      ['socialAccounts', 80, 'near'],
      ['scheduledPosts', 23, 'ok'],
      ['storageBytes', 4, 'ok'],
      // 35 of 80 USD: the overage beyond the 30 included is billed, not a problem.
      ['ai', 44, 'ok'],
      ['xApi', 0, 'ok'],
    ]);
    expect(rows.find((row) => row.key === 'ai')).toMatchObject({ included: 30_000_000, limit: 80_000_000 });
    expect(rows.filter((row) => row.monthly).map((row) => row.key)).toEqual(['scheduledPosts', 'ai', 'xApi']);
  });

  it('marks what is beyond its limit after a downgrade', () => {
    const rows = usageRowsOf(
      overview({
        plan: { key: 'starter', limits: STARTER, price: price(1_900) },
        usage: { ...overview().usage, workspaces: { used: 2, limit: 1 } },
      }),
    );
    expect(rows.find((row) => row.key === 'workspaces')).toMatchObject({ percent: 100, state: 'over' });
  });
});

describe('beyondLimitsOf', () => {
  it('names what a smaller plan would have too many of', () => {
    expect(beyondLimitsOf(overview(), STARTER).map((row) => [row.key, row.used, row.limit])).toEqual([
      ['workspaces', 2, 1],
      ['members', 10, 3],
      ['socialAccounts', 12, 5],
    ]);
    expect(beyondLimitsOf(overview(), PRO)).toEqual([]);
  });
});

describe('planActionOf', () => {
  it('changes a running plan in place and offers a checkout otherwise', () => {
    expect(planActionOf(overview(), 'pro')).toBe('current');
    expect(planActionOf(overview(), 'starter')).toBe('change');
    // No price in Stripe.
    expect(planActionOf(overview(), 'agency')).toBe('unavailable');

    const trial = overview({
      plan: { key: 'trial', limits: STARTER, price: null },
      status: 'TRIALING',
      hasRunningSubscription: false,
    });
    expect(planActionOf(trial, 'trial')).toBe('current');
    expect(planActionOf(trial, 'pro')).toBe('checkout');

    // An ended subscription buys its plan again.
    const ended = overview({ status: 'CANCELED', access: 'read_only', hasRunningSubscription: false });
    expect(planActionOf(ended, 'pro')).toBe('checkout');
    expect(planActionOf(overview({ billingEnabled: false }), 'starter')).toBe('unavailable');
  });

  it('offers the paid plans only', () => {
    expect(offeredPlansOf(overview()).map((plan) => plan.key)).toEqual(['starter', 'pro', 'agency']);
  });
});

describe('noticeOf', () => {
  const now = new Date('2026-10-17T12:00:00Z');

  it('tells read-only, an overdue payment and a trial about to end apart', () => {
    expect(
      noticeOf({ access: 'read_only', status: 'CANCELED', trialEndsAt: null, graceEndsAt: null }, now),
    ).toEqual({ kind: 'read_only' });
    expect(
      noticeOf(
        { access: 'full', status: 'PAST_DUE', trialEndsAt: null, graceEndsAt: '2026-10-20T12:00:00.000Z' },
        now,
      ),
    ).toEqual({ kind: 'past_due', graceEndsAt: '2026-10-20T12:00:00.000Z' });
    expect(
      noticeOf(
        { access: 'full', status: 'TRIALING', trialEndsAt: '2026-10-20T12:00:00.000Z', graceEndsAt: null },
        now,
      ),
    ).toEqual({ kind: 'trial_ending', trialEndsAt: '2026-10-20T12:00:00.000Z' });
  });

  it('stays quiet while everything runs', () => {
    expect(
      noticeOf(
        { access: 'full', status: 'TRIALING', trialEndsAt: '2026-10-25T12:00:00.000Z', graceEndsAt: null },
        now,
      ),
    ).toBeNull();
    expect(
      noticeOf({ access: 'full', status: 'ACTIVE', trialEndsAt: null, graceEndsAt: null }, now),
    ).toBeNull();
  });
});

describe('units', () => {
  it('reads the minor units of the currency and sizes in 1024', () => {
    expect(fromMinorUnits(4_900, 'eur')).toBe(49);
    expect(fromMinorUnits(4_900, 'jpy')).toBe(4_900);
    expect(bytesIn(25 * 1024 ** 3)).toEqual({ value: 25, unit: 'gigabyte' });
    expect(bytesIn(1_500_000)).toEqual({ value: 1_500_000 / 1024 ** 2, unit: 'megabyte' });
    expect(bytesIn(0)).toEqual({ value: 0, unit: 'kilobyte' });
  });
});
