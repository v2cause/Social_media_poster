import { describe, expect, it } from 'vitest';

import { SubscriptionDeletionBilling } from '../../src';
import { FakeBillingGateway, MemorySubscriptions, subscriptionOf } from '../in-memory-billing';

// Guide step 8.2: a paid subscription of an organization in deletion ends with its period and
// renews again when the deletion is taken back; a trial or an ended subscription is left alone.

const ORG = '0192f000-0000-7000-8000-000000000001';

describe('the subscription of an organization in deletion', () => {
  it('ends a running paid subscription with its period and lets it renew again', async () => {
    const subscriptions = new MemorySubscriptions();
    const gateway = new FakeBillingGateway();
    subscriptions.put(
      subscriptionOf(ORG, 'pro', { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' }),
    );
    const billing = new SubscriptionDeletionBilling({ subscriptions, gateway });

    await billing.endWithPeriod(ORG, true);
    await billing.endWithPeriod(ORG, false);

    expect(gateway.periodEnds).toEqual([
      { subscriptionId: 'sub_1', cancel: true },
      { subscriptionId: 'sub_1', cancel: false },
    ]);
  });

  it('leaves trials, ended subscriptions and unknown organizations alone', async () => {
    const subscriptions = new MemorySubscriptions();
    const gateway = new FakeBillingGateway();
    subscriptions.put(subscriptionOf(ORG, 'trial'));
    subscriptions.put(
      subscriptionOf('0192f000-0000-7000-8000-000000000002', 'pro', {
        stripeSubscriptionId: 'sub_2',
        status: 'CANCELED',
      }),
    );
    const billing = new SubscriptionDeletionBilling({ subscriptions, gateway });

    await billing.endWithPeriod(ORG, true);
    await billing.endWithPeriod('0192f000-0000-7000-8000-000000000002', true);
    await billing.endWithPeriod('0192f000-0000-7000-8000-000000000003', true);

    expect(gateway.periodEnds).toEqual([]);
  });
});
