import { describe, expect, it } from 'vitest';

import {
  EntitlementsService,
  GetBillingOverview,
  NotPermittedError,
  PlanPrices,
  type OrganizationActor,
  type PlanPrice,
  type PlanUsage,
} from '../../src';
import { FakeBillingGateway, MemorySubscriptions, subscriptionOf } from '../in-memory-billing';
import { MovingClock } from '../in-memory-publish-job';

// Guide step 7.5: the billing page shows the plan and its state, what the organization uses of
// every limit, also beyond a limit after a downgrade, and the plans with their prices. The prices
// stay in memory, a list that misses one only briefly.

const ORG = '0192f000-0000-7000-8000-000000000001';
const owner: OrganizationActor = { userId: 'user-1', organizationId: ORG, role: 'OWNER' };

const usage: PlanUsage = {
  workspaces: () => Promise.resolve(2),
  members: () => Promise.resolve(4),
  socialAccounts: () => Promise.resolve(3),
  postsInMonth: (_organizationId, _at, exceptVariantId) => Promise.resolve(exceptVariantId ? 0 : 12),
  storageBytes: () => Promise.resolve(1_500_000),
  xApiSpendMicros: () => Promise.resolve(45_000),
};

const testbed = (withPrices = true) => {
  const subscriptions = new MemorySubscriptions();
  const clock = new MovingClock(Date.parse('2026-10-17T12:00:00Z'));
  const gateway = new FakeBillingGateway();
  const asked: string[][] = [];
  const prices = new PlanPrices({
    gateway: {
      prices: (lookupKeys) => {
        asked.push([...lookupKeys]);
        return gateway.prices(lookupKeys);
      },
    },
    clock,
  });
  const overview = new GetBillingOverview({
    entitlements: new EntitlementsService({ subscriptions, clock }),
    subscriptions,
    usage,
    quota: {
      usage: () => Promise.resolve({ used: 1_250_000n, limit: 20_000_000n, periodStart: clock.now() }),
    },
    prices: withPrices ? prices : null,
    clock,
  });
  return { subscriptions, clock, overview, asked };
};

describe('the billing overview', () => {
  it('shows the plan, the usage of every limit and the plans with their prices', async () => {
    const { subscriptions, overview } = testbed();
    // Down from pro to starter: two workspaces stay where starter allows one.
    subscriptions.put(
      subscriptionOf(ORG, 'starter', { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' }),
    );

    const result = await overview.execute(owner);

    expect(result.entitlements).toMatchObject({
      plan: { key: 'starter' },
      status: 'ACTIVE',
      readOnly: false,
    });
    expect(result.entitlements.limits.maxWorkspaces).toBe(1);
    expect(result.billingEnabled).toBe(true);
    expect(result.hasRunningSubscription).toBe(true);
    expect(result.periodStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(result.usage).toEqual({
      workspaces: 2,
      members: 4,
      socialAccounts: 3,
      scheduledPosts: 12,
      storageBytes: 1_500_000,
      xApiMicros: 45_000,
      aiMicros: 1_250_000,
    });
    expect(result.plans.map(({ plan, price }) => [plan.key, price?.unitAmount ?? null])).toEqual([
      ['trial', null],
      ['starter', 4900],
      ['pro', 4900],
      ['agency', 4900],
    ]);
  });

  it('shows the plans without prices where Stripe is not set up', async () => {
    const { subscriptions, overview } = testbed(false);
    subscriptions.put(subscriptionOf(ORG, 'trial', { status: 'TRIALING' }));

    const result = await overview.execute(owner);

    expect(result.billingEnabled).toBe(false);
    expect(result.hasRunningSubscription).toBe(false);
    expect(result.plans.every(({ price }) => price === null)).toBe(true);
  });

  it('is for owners only', async () => {
    const { overview } = testbed();

    await expect(overview.execute({ ...owner, role: 'ADMIN' })).rejects.toBeInstanceOf(NotPermittedError);
  });

  it('keeps the prices for ten minutes, and a list that misses one for a minute', async () => {
    const clock = new MovingClock(Date.parse('2026-10-17T12:00:00Z'));
    const answers: PlanPrice[][] = [
      [{ lookupKey: 'smp_pro_monthly', unitAmount: 4900, currency: 'eur', interval: 'month' }],
      [
        { lookupKey: 'smp_pro_monthly', unitAmount: 4900, currency: 'eur', interval: 'month' },
        { lookupKey: 'smp_agency_monthly', unitAmount: 14900, currency: 'eur', interval: 'month' },
      ],
    ];
    let asked = 0;
    const prices = new PlanPrices({
      gateway: {
        prices: () => {
          asked += 1;
          return Promise.resolve(answers[Math.min(asked, answers.length) - 1] ?? []);
        },
      },
      clock,
    });
    const keys = ['smp_pro_monthly', 'smp_agency_monthly'];

    // Stripe answered without the price of agency: asked again after a minute.
    await expect(prices.of(keys)).resolves.toHaveLength(1);
    clock.advance(59_000);
    await expect(prices.of(keys)).resolves.toHaveLength(1);
    clock.advance(2_000);
    await expect(prices.of(keys)).resolves.toHaveLength(2);
    expect(asked).toBe(2);

    // The complete list stays ten minutes, also when the keys come in another order.
    clock.advance(9 * 60_000);
    await expect(prices.of([...keys].reverse())).resolves.toHaveLength(2);
    expect(asked).toBe(2);
    clock.advance(61_000);
    await prices.of(keys);
    expect(asked).toBe(3);
  });
});
