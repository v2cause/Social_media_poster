import { describe, expect, it } from 'vitest';

import {
  EntitlementsService,
  isPlatformError,
  planAccountLimits,
  planAnalyticsHistory,
  planMediaLimits,
  planQuotaLimits,
  planXSpendCap,
} from '../../src';
import { MemorySubscriptions, subscriptionOf } from '../in-memory-billing';
import { MovingClock } from '../in-memory-publish-job';

// Guide step 7.4: every module reads its limit from the plan of the organization, with the
// overrides of the operators.

const ORG = '0192f000-0000-7000-8000-000000000001';

const testbed = () => {
  const subscriptions = new MemorySubscriptions();
  const clock = new MovingClock(Date.parse('2026-10-17T12:00:00Z'));
  subscriptions.put(subscriptionOf(ORG, 'starter', { limitOverrides: { analyticsHistoryDays: 120 } }));
  return { subscriptions, clock, entitlements: new EntitlementsService({ subscriptions, clock }) };
};

describe('the limits of the plan for the modules', () => {
  it('gives the AI quota, the history and the storage of the plan', async () => {
    const { entitlements } = testbed();

    // Starter: 10 USD of credits and 10 USD of overage.
    await expect(planQuotaLimits(entitlements).limitOf(ORG, 'ai_micros')).resolves.toBe(20_000_000n);
    await expect(planAnalyticsHistory(entitlements).daysOf(ORG)).resolves.toBe(120);
    const media = planMediaLimits(entitlements, { storageBytes: () => Promise.resolve(42) });
    await expect(media.storageBytes(ORG)).resolves.toBe(5 * 1024 ** 3);
    await expect(media.storageUsed(ORG)).resolves.toBe(42);
  });

  it('refuses accounts beyond the plan, and asks nothing for none', async () => {
    const { entitlements } = testbed();
    let asked = 0;
    const limits = planAccountLimits(entitlements, {
      socialAccounts: () => {
        asked += 1;
        return Promise.resolve(4);
      },
    });

    await expect(limits.assertRoom(ORG, 1)).resolves.toBeUndefined();
    await expect(limits.assertRoom(ORG, 2)).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      params: { limit: 'maxSocialAccounts', max: 5 },
    });
    await limits.assertRoom(ORG, 0);
    expect(asked).toBe(2);
  });

  it('stops an X API call that would pass the spending cap of the month', async () => {
    const { entitlements, clock } = testbed();
    const months: string[] = [];
    const cap = planXSpendCap(
      entitlements,
      {
        xApiSpendMicros: (_organizationId, at) => {
          months.push(at.toISOString().slice(0, 7));
          return Promise.resolve(9_990_000);
        },
      },
      clock,
    );

    // Starter allows 10 USD of X API costs a month.
    await expect(cap.assertRoom(ORG, 10_000)).resolves.toBeUndefined();
    const refused = await cap.assertRoom(ORG, 15_000).catch((error: unknown) => error);
    expect(isPlatformError(refused) && refused.code).toBe('SPEND_CAP_REACHED');
    expect(isPlatformError(refused) && refused.retryable).toBe(false);
    await cap.assertRoom(ORG, 0);
    expect(months).toEqual(['2026-10', '2026-10']);
  });
});
