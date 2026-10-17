import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  billingEventOf,
  createStripeClient,
  meteredLookupKeys,
  StripeBillingGateway,
  syncCatalog,
  type StripeClient,
} from '@smp/billing';
import { BILLING_WEBHOOK_TYPES, RecordStripeWebhook } from '@smp/core';
import { createPrismaClient, PrismaWebhookRecorder, type PrismaClient } from '@smp/db';
import { BILLING_QUEUE, BillingProducer } from '@smp/queue';
import { startRedis, startTestDatabase, type StartedRedis, type TestDatabase } from '@smp/testing';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';

// Guide step 7.5, "Fertig, wenn", against the test mode of the real Stripe: a customer on a test
// clock subscribes to Starter, upgrades to Pro, downgrades to Starter again, fails the renewal when
// the clock passes the end of the period, and cancels. The test has no public address for
// webhooks, so it reads the events of the customer from the events API and records each one the
// way the API records a webhook; the worker role "billing" does the rest as in production.
//
// Runs only with STRIPE_TEST_CLOCK_SECRET_KEY, a test key (sk_test_...) of a Stripe account in test
// mode; it creates the price list there like `pnpm stripe:sync` and deletes its test clock with
// the customer afterwards. The fake Stripe covers the same steps in CI (apps/web/e2e/billing.spec.ts).
// The test cards pm_card_visa and pm_card_chargeCustomerFail are the test payment methods of
// Stripe: the second one attaches, but every charge fails.

const SECRET_KEY = process.env['STRIPE_TEST_CLOCK_SECRET_KEY'] ?? '';
const LIVE = SECRET_KEY.startsWith('sk_test_');
const DAY_SECONDS = 24 * 60 * 60;

const org = randomUUID();
const owner = randomUUID();

interface SubscriptionRow {
  plan_key: string;
  status: string;
  stripe_subscription_id: string | null;
  past_due_since: Date | null;
  read_only_at: Date | null;
}

describe.runIf(LIVE)('billing against the test clocks of Stripe', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let stripe: StripeClient | undefined;
  let app: PrismaClient | undefined;
  let worker: INestApplicationContext | undefined;
  let billingQueue: Queue | undefined;
  let record: RecordStripeWebhook | undefined;
  let clockId: string | undefined;
  let customerId = '';
  const recorded = new Set<string>();

  const started = () => {
    if (!database || !stripe || !record) {
      throw new Error('not started');
    }
    return { database, stripe, record };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const subscription = async (): Promise<SubscriptionRow | undefined> =>
    (
      await query<SubscriptionRow>(
        `SELECT plan_key, status, stripe_subscription_id, past_due_since, read_only_at
         FROM subscription WHERE organization_id = $1`,
        [org],
      )
    )[0];

  /** Records the new events of the customer like webhooks, oldest first. */
  const deliverEvents = async (): Promise<void> => {
    const { stripe, record } = started();
    const { data } = await stripe.events.list({ types: [...BILLING_WEBHOOK_TYPES], limit: 100 });
    const ours = data
      .map(billingEventOf)
      .filter((event) => event.customerId === customerId && !recorded.has(event.id))
      .reverse();
    for (const event of ours) {
      await record.execute(event);
      recorded.add(event.id);
    }
  };
  /** Delivers events until the subscription in the database matches, for a minute at most. */
  const settled = async (expected: Partial<SubscriptionRow>): Promise<SubscriptionRow> => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await deliverEvents();
      const row = await subscription();
      if (
        row &&
        Object.entries(expected).every(([key, value]) => row[key as keyof SubscriptionRow] === value)
      ) {
        return row;
      }
      await sleep(1_000);
    }
    throw new Error(
      `The subscription did not reach ${JSON.stringify(expected)}: ${JSON.stringify(await subscription())}`,
    );
  };
  /** Moves the test clock and waits until Stripe has run everything up to that moment. */
  const advanceTo = async (frozenTime: number): Promise<void> => {
    const { stripe } = started();
    if (!clockId) {
      throw new Error('no test clock');
    }
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: frozenTime });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
      if (clock.status === 'ready') {
        return;
      }
      if (clock.status === 'internal_failure') {
        throw new Error('The test clock of Stripe failed to advance.');
      }
      await sleep(1_000);
    }
    throw new Error('The test clock of Stripe did not finish advancing.');
  };
  /** Attaches a test payment method to the customer and makes it the default for invoices. */
  const payWith = async (testPaymentMethod: string): Promise<void> => {
    const { stripe } = started();
    const method = await stripe.paymentMethods.attach(testPaymentMethod, { customer: customerId });
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: method.id } });
  };
  const priceId = async (lookupKey: string): Promise<string> => {
    const { data } = await started().stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const price = data[0];
    if (!price) {
      throw new Error(`No active price ${lookupKey}`);
    }
    return price.id;
  };

  beforeAll(async () => {
    [database, redis] = await Promise.all([startTestDatabase(), startRedis()]);
    stripe = createStripeClient({ secretKey: SECRET_KEY });
    await syncCatalog(stripe);

    app = createPrismaClient(database.url('app_user'));
    billingQueue = new Queue(BILLING_QUEUE, { connection: { url: redis.url } });
    const producer = new BillingProducer(billingQueue);
    record = new RecordStripeWebhook({
      inbox: new PrismaWebhookRecorder(app),
      jobs: { processWebhook: (eventId) => producer.stripeWebhook({ eventId }) },
    });
    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      WORKER_ROLES: 'billing',
      WORKER_HEALTH_PORT: '0',
      REDIS_URL: redis.url,
      DATABASE_URL: database.url('app_user'),
      DATABASE_SYSTEM_URL: database.url('app_system'),
      APP_URL: 'http://localhost:3000/',
      STRIPE_SECRET_KEY: SECRET_KEY,
    });
    worker = await NestFactory.createApplicationContext(WorkerModule.forRoles(['billing'], env), {
      logger: false,
    });
    await worker.init();

    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Testuhr GmbH', now())`, [org]);
    await query(
      `INSERT INTO users (id, name, email, email_verified, updated_at)
       VALUES ($1, 'Tilda', $2, true, now())`,
      [owner, `tilda-${org}@example.com`],
    );
    await query(
      `INSERT INTO membership (id, organization_id, user_id, role, updated_at) VALUES ($1, $2, $3, 'OWNER', now())`,
      [randomUUID(), org, owner],
    );
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1000),
      name: `smp-${org}`,
    });
    clockId = clock.id;
    const customer = await stripe.customers.create({
      name: 'Testuhr GmbH',
      email: `tilda-${org}@example.com`,
      test_clock: clock.id,
      metadata: { organizationId: org },
    });
    customerId = customer.id;
    await query(
      `INSERT INTO subscription (id, organization_id, plan_key, status, trial_ends_at, read_only_at,
                                 stripe_customer_id, updated_at)
       VALUES ($1, $2, 'trial', 'TRIALING', now() + interval '14 days', now() + interval '14 days', $3, now())`,
      [randomUUID(), org, customerId],
    );
  }, 300_000);

  afterAll(async () => {
    // Deleting the test clock deletes its customer and subscription in Stripe.
    if (stripe && clockId) {
      await stripe.testHelpers.testClocks.del(clockId);
    }
    await billingQueue?.close();
    await worker?.close();
    await app?.$disconnect();
    await Promise.all([database?.stop(), redis?.stop()]);
  });

  it('follows upgrade, downgrade, a failed renewal and the cancellation', { timeout: 600_000 }, async () => {
    const { stripe } = started();
    await payWith('pm_card_visa');

    // A paid subscription to Starter, with the metered prices as the checkout adds them.
    const created = await stripe.subscriptions.create({
      customer: customerId,
      items: [
        { price: await priceId('smp_starter_monthly'), quantity: 1 },
        ...(await Promise.all(meteredLookupKeys().map(async (key) => ({ price: await priceId(key) })))),
      ],
      metadata: { organizationId: org },
    });
    expect(await settled({ plan_key: 'starter', status: 'ACTIVE' })).toMatchObject({
      stripe_subscription_id: created.id,
      read_only_at: null,
    });

    // Upgrade and downgrade in place, as the billing page does.
    const gateway = new StripeBillingGateway(stripe);
    await gateway.changePlan({ subscriptionId: created.id, priceLookupKey: 'smp_pro_monthly' });
    await settled({ plan_key: 'pro', status: 'ACTIVE' });
    await gateway.changePlan({ subscriptionId: created.id, priceLookupKey: 'smp_starter_monthly' });
    await settled({ plan_key: 'starter', status: 'ACTIVE' });

    // The renewal fails: past_due with seven days of grace.
    await payWith('pm_card_chargeCustomerFail');
    const current = await stripe.subscriptions.retrieve(created.id);
    const periodEnd = Math.max(...current.items.data.map((item) => item.current_period_end));
    await advanceTo(periodEnd + DAY_SECONDS);
    const pastDue = await settled({ status: 'PAST_DUE' });
    expect(pastDue.past_due_since).toBeInstanceOf(Date);
    expect(pastDue.read_only_at?.getTime()).toBe(
      (pastDue.past_due_since?.getTime() ?? 0) + 7 * DAY_SECONDS * 1000,
    );

    // The cancellation makes the organization read-only at once.
    await stripe.subscriptions.cancel(created.id);
    const canceled = await settled({ status: 'CANCELED' });
    expect(canceled.read_only_at?.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
