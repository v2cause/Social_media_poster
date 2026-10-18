import { describe, expect, it } from 'vitest';

import { ProcessStripeWebhook, RecordStripeWebhook, type ProviderSubscription } from '../../src';
import {
  FakeBillingGateway,
  MemoryBillingStores,
  MemorySubscriptions,
  RecordingBillingNotifier,
  RecordingLock,
  subscriptionOf,
} from '../in-memory-billing';
import { MovingClock } from '../in-memory-publish-job';

// Guide step 7.2: every webhook once into the inbox and the queue; the role "billing" reads the
// subscription from the provider and takes it over, whatever the order of the events.

const ORG = '0192f000-0000-7000-8000-000000000001';
const NOW = Date.parse('2026-10-17T12:00:00Z');

const testbed = () => {
  const subscriptions = new MemorySubscriptions();
  const stores = new MemoryBillingStores(subscriptions);
  const gateway = new FakeBillingGateway();
  const notifier = new RecordingBillingNotifier();
  const lock = new RecordingLock();
  const clock = new MovingClock(NOW);
  subscriptions.put(
    subscriptionOf(ORG, 'trial', {
      status: 'TRIALING',
      stripeCustomerId: 'cus_1',
      trialEndsAt: new Date('2026-10-25T00:00:00Z'),
      readOnlyAt: new Date('2026-10-25T00:00:00Z'),
    }),
  );
  return {
    subscriptions,
    stores,
    gateway,
    notifier,
    lock,
    clock,
    record: new RecordStripeWebhook({ inbox: stores, jobs: stores }),
    process: new ProcessStripeWebhook({
      inbox: stores,
      gateway,
      subscriptions,
      sync: stores,
      lock,
      notifier,
      clock,
    }),
  };
};

const subscription = (patch: Partial<ProviderSubscription>): ProviderSubscription => ({
  id: 'sub_1',
  customerId: 'cus_1',
  status: 'ACTIVE',
  priceLookupKeys: ['smp_pro_monthly', 'smp_ai_overage', 'smp_x_api_cost'],
  currentPeriodStart: new Date('2026-10-17T12:00:00Z'),
  currentPeriodEnd: new Date('2026-11-17T12:00:00Z'),
  cancelAtPeriodEnd: false,
  startedAt: new Date('2026-10-17T12:00:00Z'),
  trialEnd: null,
  ...patch,
});

const event = (id: string, type: string) => ({
  id,
  type,
  createdAt: new Date(NOW),
  subscriptionId: 'sub_1',
  customerId: 'cus_1',
});

describe('the webhooks of Stripe', () => {
  it('records an event once, queues it until it is processed and ignores other types', async () => {
    const { stores, record, process, gateway } = testbed();
    gateway.subscriptions.set('sub_1', subscription({}));

    await expect(record.execute(event('evt_1', 'customer.subscription.created'))).resolves.toBe('queued');
    await expect(record.execute(event('evt_1', 'customer.subscription.created'))).resolves.toBe('queued');
    await expect(process.execute('evt_1')).resolves.toBe('synced');
    await expect(record.execute(event('evt_1', 'customer.subscription.created'))).resolves.toBe('duplicate');
    await expect(record.execute(event('evt_2', 'customer.created'))).resolves.toBe('ignored');

    expect(stores.queued).toEqual(['evt_1', 'evt_1']);
    await expect(process.execute('evt_1')).resolves.toBe('done_before');
    await expect(process.execute('evt_unknown')).resolves.toBe('missing');
  });

  it('takes over the subscription read from the provider, under the lock of the customer', async () => {
    const { subscriptions, record, process, gateway, lock } = testbed();
    gateway.subscriptions.set('sub_1', subscription({}));
    await record.execute(event('evt_1', 'checkout.session.completed'));

    await expect(process.execute('evt_1')).resolves.toBe('synced');

    expect(subscriptions.rows.get(ORG)).toMatchObject({
      plan: { key: 'pro' },
      status: 'ACTIVE',
      stripeSubscriptionId: 'sub_1',
      readOnlyAt: null,
      trialEndsAt: null,
      billingStartedAt: new Date('2026-10-17T12:00:00Z'),
    });
    expect(lock.keys).toEqual(['billing.cus_1']);
  });

  it('applies the state of the provider whatever the order of the events', async () => {
    const { subscriptions, record, process, gateway } = testbed();
    // The update arrives before the creation; both read the same subscription.
    gateway.subscriptions.set('sub_1', subscription({ priceLookupKeys: ['smp_agency_monthly'] }));
    await record.execute(event('evt_update', 'customer.subscription.updated'));
    await record.execute(event('evt_create', 'customer.subscription.created'));

    await process.execute('evt_update');
    await process.execute('evt_create');

    expect(subscriptions.rows.get(ORG)).toMatchObject({ plan: { key: 'agency' }, status: 'ACTIVE' });
  });

  it('tells the owners once when a payment fails and starts the grace period', async () => {
    const { subscriptions, record, process, gateway, notifier, clock } = testbed();
    gateway.subscriptions.set('sub_1', subscription({}));
    await record.execute(event('evt_1', 'customer.subscription.created'));
    await process.execute('evt_1');

    gateway.subscriptions.set('sub_1', subscription({ status: 'PAST_DUE' }));
    await record.execute(event('evt_2', 'invoice.payment_failed'));
    await process.execute('evt_2');
    clock.advance(60 * 60 * 1000);
    await record.execute(event('evt_3', 'customer.subscription.updated'));
    await process.execute('evt_3');

    expect(notifier.paymentsFailed).toEqual([
      { eventId: 'evt_2', organizationId: ORG, graceEndsAt: new Date('2026-10-24T12:00:00Z') },
    ]);
    expect(subscriptions.rows.get(ORG)).toMatchObject({
      status: 'PAST_DUE',
      pastDueSince: new Date(NOW),
      readOnlyAt: new Date('2026-10-24T12:00:00Z'),
    });
  });

  it('keeps the state until the owners could be told, so the event tells them when it runs again', async () => {
    const { subscriptions, record, process, gateway, notifier } = testbed();
    gateway.subscriptions.set('sub_1', subscription({}));
    await record.execute(event('evt_1', 'customer.subscription.created'));
    await process.execute('evt_1');

    gateway.subscriptions.set('sub_1', subscription({ status: 'PAST_DUE' }));
    await record.execute(event('evt_2', 'invoice.payment_failed'));
    notifier.failNext = true;
    await expect(process.execute('evt_2')).rejects.toThrow('queue away');
    expect(subscriptions.rows.get(ORG)).toMatchObject({ status: 'ACTIVE', pastDueSince: null });

    await expect(process.execute('evt_2')).resolves.toBe('synced');
    expect(notifier.paymentsFailed).toEqual([expect.objectContaining({ eventId: 'evt_2' })]);
    expect(subscriptions.rows.get(ORG)).toMatchObject({ status: 'PAST_DUE' });
  });

  it('leaves the organization alone for unknown customers, subscriptions and checkouts that did not go through', async () => {
    const { subscriptions, stores, record, process, gateway } = testbed();
    await record.execute(event('evt_1', 'customer.subscription.updated'));
    await expect(process.execute('evt_1')).resolves.toBe('unknown_subscription');

    // The event of a customer no organization knows, as after an erasure, is not kept.
    gateway.subscriptions.set('sub_1', subscription({ customerId: 'cus_other' }));
    await record.execute(event('evt_2', 'customer.subscription.updated'));
    await expect(process.execute('evt_2')).resolves.toBe('unknown_customer');
    expect([...stores.webhooks.keys()]).toEqual(['evt_1']);

    gateway.subscriptions.set('sub_1', subscription({ status: 'INCOMPLETE' }));
    await record.execute(event('evt_3', 'customer.subscription.created'));
    await expect(process.execute('evt_3')).resolves.toBe('not_started');

    await record.execute({ ...event('evt_4', 'invoice.paid'), subscriptionId: null });
    await expect(process.execute('evt_4')).resolves.toBe('no_subscription');

    expect(subscriptions.rows.get(ORG)).toMatchObject({ status: 'TRIALING', plan: { key: 'trial' } });
  });
});
