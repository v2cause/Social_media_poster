import { randomUUID } from 'node:crypto';

import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  createSystemPrismaClient,
  PrismaBillingCustomers,
  PrismaBillingDirectory,
  PrismaSubscriptionReader,
  PrismaSubscriptionSync,
  PrismaWebhookInbox,
  PrismaWebhookRecorder,
  runInSystemScope,
  type PrismaClient,
  type SystemPrismaClient,
} from '../src';

// Guide step 7.2 on PostgreSQL: the checkout stores the Stripe customer once as app_user, the API
// records a webhook once as app_user, and the role "billing" reads it and writes the subscription
// as app_system.

describe('billing adapters on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let app: PrismaClient | undefined;
  let system: SystemPrismaClient | undefined;
  const org = randomUUID();
  const owner = randomUUID();

  const clients = () => {
    if (!app || !system) {
      throw new Error('not started');
    }
    return { app, system };
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    const fixtures = await database.connectAs('app_system');
    try {
      await fixtures.query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Acme', now())`, [
        org,
      ]);
      await fixtures.query(
        `INSERT INTO users (id, email, name, email_verified, locale, updated_at)
         VALUES ($1, 'owner@acme.test', 'Olga Owner', true, 'en', now()),
                ($2, 'unverified@acme.test', 'Una', false, 'de', now())`,
        [owner, randomUUID()],
      );
      await fixtures.query(
        `INSERT INTO membership (id, organization_id, user_id, role, updated_at)
         SELECT gen_random_uuid(), $1, id, 'OWNER', now() FROM users`,
        [org],
      );
      await fixtures.query(
        `INSERT INTO subscription (id, organization_id, plan_key, status, trial_ends_at, read_only_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'trial', 'TRIALING', now() + interval '14 days', now() + interval '14 days', now())`,
        [org],
      );
    } finally {
      await fixtures.end();
    }
    app = createPrismaClient(database.url('app_user'));
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await Promise.all([app?.$disconnect(), system?.$disconnect()]);
    await database?.stop();
  });

  it('keeps the first Stripe customer of an organization', async () => {
    const customers = new PrismaBillingCustomers(clients().app);

    await expect(customers.saveCustomer(org, 'cus_first')).resolves.toBe('cus_first');
    await expect(customers.saveCustomer(org, 'cus_second')).resolves.toBe('cus_first');
    await expect(new PrismaSubscriptionReader(clients().app).find(org)).resolves.toMatchObject({
      stripeCustomerId: 'cus_first',
      status: 'TRIALING',
    });
  });

  it('records a webhook once with its ids only and marks it processed', async () => {
    const recorder = new PrismaWebhookRecorder(clients().app);
    const inbox = new PrismaWebhookInbox(clients().system);
    const event = {
      id: 'evt_1',
      type: 'customer.subscription.updated',
      subscriptionId: 'sub_1',
      customerId: 'cus_first',
    };

    await expect(recorder.record(event)).resolves.toEqual({ processed: false });
    await expect(recorder.record(event)).resolves.toEqual({ processed: false });
    await expect(inbox.find('evt_1')).resolves.toEqual({ ...event, processedAt: null });

    const at = new Date('2026-10-17T12:00:00Z');
    await inbox.markProcessed('evt_1', at);
    await inbox.markProcessed('evt_1', new Date('2026-10-18T12:00:00Z'));
    await expect(inbox.find('evt_1')).resolves.toMatchObject({ processedAt: at });
    await expect(recorder.record(event)).resolves.toEqual({ processed: true });
    await expect(inbox.find('evt_unknown')).resolves.toBeNull();
  });

  it('writes the state from Stripe and announces a new moment of read-only access again', async () => {
    const sync = new PrismaSubscriptionSync(clients().system);
    const local = await sync.byCustomer('cus_first');
    expect(local).toMatchObject({ organizationId: org, plan: { key: 'trial' } });
    expect((await sync.plans()).map((plan) => [plan.key, plan.priceLookupKey])).toEqual([
      ['trial', null],
      ['starter', 'smp_starter_monthly'],
      ['pro', 'smp_pro_monthly'],
      ['agency', 'smp_agency_monthly'],
    ]);
    const state = {
      planKey: 'pro' as const,
      status: 'PAST_DUE' as const,
      trialEndsAt: null,
      stripeSubscriptionId: 'sub_1',
      currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      pastDueSince: new Date('2026-10-10T00:00:00Z'),
      readOnlyAt: new Date('2026-10-17T00:00:00Z'),
      billingStartedAt: new Date('2026-10-01T00:00:00Z'),
    };

    await sync.save(org, state);
    await runInSystemScope(
      () =>
        clients().system
          .$executeRaw`UPDATE subscription SET read_only_notified_at = now() WHERE organization_id = ${org}::uuid`,
    );
    await sync.save(org, { ...state, currentPeriodEnd: new Date('2026-11-02T00:00:00Z') });
    const kept = await runInSystemScope(() =>
      clients().system.subscription.findUniqueOrThrow({ where: { organizationId: org } }),
    );
    expect(kept.readOnlyNotifiedAt).not.toBeNull();

    await sync.save(org, { ...state, status: 'CANCELED', readOnlyAt: new Date('2026-10-20T00:00:00Z') });
    const renewed = await runInSystemScope(() =>
      clients().system.subscription.findUniqueOrThrow({ where: { organizationId: org } }),
    );
    expect(renewed).toMatchObject({ planKey: 'pro', status: 'CANCELED', readOnlyNotifiedAt: null });
    expect(renewed.syncedAt).not.toBeNull();
    await expect(sync.byCustomer('cus_unknown')).resolves.toBeNull();
  });

  it('names the owners with a verified address in their language', async () => {
    const directory = new PrismaBillingDirectory(clients().system);

    await expect(directory.owners(org)).resolves.toEqual({
      organizationName: 'Acme',
      owners: [
        {
          userId: owner,
          email: 'owner@acme.test',
          name: 'Olga Owner',
          locale: 'en',
          timezone: 'Europe/Berlin',
        },
      ],
    });
    await expect(directory.owners(randomUUID())).resolves.toBeNull();
  });
});
