import { describe, expect, it } from 'vitest';

import { EntitlementsService, PlanLimitReachedError, SubscriptionInactiveError } from '../../src';
import { MemorySubscriptions, subscriptionOf } from '../in-memory-billing';
import { MovingClock } from '../in-memory-publish-job';

// Guide steps 7.2 and 7.4: the limits and the access of an organization under its subscription.

const ORG = '0192f000-0000-7000-8000-000000000001';
const NOW = Date.parse('2026-10-17T12:00:00Z');

const testbed = (cacheMs = 0) => {
  const subscriptions = new MemorySubscriptions();
  const clock = new MovingClock(NOW);
  return { subscriptions, clock, service: new EntitlementsService({ subscriptions, clock, cacheMs }) };
};

describe('the entitlements of an organization', () => {
  it('takes the limits of the plan with the overrides of the operators', async () => {
    const { subscriptions, service } = testbed();
    subscriptions.put(subscriptionOf(ORG, 'pro', { limitOverrides: { maxSocialAccounts: 40 } }));

    const entitlements = await service.of(ORG);

    expect(entitlements.plan.key).toBe('pro');
    expect(entitlements.limits).toMatchObject({ maxSocialAccounts: 40, maxWorkspaces: 3, maxMembers: 10 });
    expect(entitlements.readOnly).toBe(false);
  });

  it('blocks only what goes beyond a limit, so what exists after a downgrade stays', async () => {
    const { subscriptions, service } = testbed();
    subscriptions.put(subscriptionOf(ORG, 'starter'));

    await expect(service.assertWithin(ORG, 'maxSocialAccounts', 4)).resolves.toBeUndefined();
    await expect(service.assertWithin(ORG, 'maxSocialAccounts', 5)).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      params: { limit: 'maxSocialAccounts', max: 5 },
    });
    await expect(service.assertWithin(ORG, 'maxSocialAccounts', 3, 3)).rejects.toBeInstanceOf(
      PlanLimitReachedError,
    );
  });

  it('turns read-only when the grace period of an overdue payment ends', async () => {
    const { subscriptions, clock, service } = testbed();
    const pastDueSince = new Date('2026-10-16T12:00:00Z');
    subscriptions.put(
      subscriptionOf(ORG, 'pro', {
        status: 'PAST_DUE',
        pastDueSince,
        readOnlyAt: new Date('2026-10-23T12:00:00Z'),
        stripeSubscriptionId: 'sub_1',
      }),
    );

    const during = await service.assertWritable(ORG);
    expect(during.graceEndsAt).toEqual(new Date('2026-10-23T12:00:00Z'));
    clock.advance(6 * 24 * 60 * 60 * 1000);
    await expect(service.assertWritable(ORG)).rejects.toBeInstanceOf(SubscriptionInactiveError);
  });

  it('treats an organization from before billing as one on the trial without an end', async () => {
    const { service } = testbed();

    const entitlements = await service.of(ORG);

    expect(entitlements).toMatchObject({ status: 'TRIALING', readOnly: false, trialEndsAt: null });
    expect(entitlements.plan.key).toBe('trial');
  });

  it('remembers a subscription for a few seconds and forgets it on request', async () => {
    const { subscriptions, clock, service } = testbed(15_000);
    subscriptions.put(subscriptionOf(ORG, 'starter'));

    await service.of(ORG);
    await service.of(ORG);
    expect(subscriptions.reads).toBe(1);
    clock.advance(15_001);
    await service.of(ORG);
    expect(subscriptions.reads).toBe(2);
    service.forget(ORG);
    await service.of(ORG);
    expect(subscriptions.reads).toBe(3);
  });
});
