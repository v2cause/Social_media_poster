import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createStripeClient, StripeBillingGateway, StripeWebhookVerifier, syncCatalog } from '@smp/billing';
import { RecordStripeWebhook } from '@smp/core';
import { createPrismaClient, PrismaWebhookRecorder, type PrismaClient } from '@smp/db';
import {
  BILLING_QUEUE,
  BillingProducer,
  NOTIFICATIONS_QUEUE,
  parseNotifyDispatch,
  usageReportJobId,
} from '@smp/queue';
import {
  FakeStripe,
  startRedis,
  startTestDatabase,
  type StartedRedis,
  type TestDatabase,
} from '@smp/testing';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';

// Guide steps 7.2 and 7.3 through the worker role "billing" against the fake Stripe: the
// webhooks of a paid checkout, a failed renewal and a cancellation are recorded the way the API
// records them, and the role reads each subscription from Stripe and takes plan and status over.
// A failed payment tells the owners once, with the end of the grace period. The daily report
// sends the AI usage beyond the credits of the plan and the X API costs to the meters, once.

const WEBHOOK_SECRET = 'whsec_test_billing_worker';
const DAY_MS = 24 * 60 * 60 * 1000;

const org = randomUUID();
const owner = randomUUID();

interface SubscriptionRow {
  plan_key: string;
  status: string;
  stripe_subscription_id: string | null;
  past_due_since: Date | null;
  read_only_at: Date | null;
  billing_started_at: Date | null;
  current_period_end: Date | null;
}

describe('billing worker', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let fake: FakeStripe | undefined;
  let receiver: Server | undefined;
  let app: PrismaClient | undefined;
  let worker: INestApplicationContext | undefined;
  let billingQueue: Queue | undefined;
  let notifications: Queue | undefined;

  const started = () => {
    if (!database || !fake || !notifications) {
      throw new Error('not started');
    }
    return { database, fake, notifications };
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
        `SELECT plan_key, status, stripe_subscription_id, past_due_since, read_only_at, billing_started_at,
                current_period_end
         FROM subscription WHERE organization_id = $1`,
        [org],
      )
    )[0];
  /** Waits until the role processed every recorded event. */
  const settled = async (events: number): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await query<{ total: number; open: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE processed_at IS NULL)::int AS open
         FROM webhook_event WHERE provider = 'stripe'`,
      );
      if (row && row.total >= events && row.open === 0) {
        return;
      }
      await sleep(100);
    }
    throw new Error(`The role "billing" did not process ${String(events)} events in time.`);
  };

  beforeAll(async () => {
    [database, redis] = await Promise.all([startTestDatabase(), startRedis()]);
    fake = await FakeStripe.start({ webhookSecret: WEBHOOK_SECRET });
    const stripe = createStripeClient({ secretKey: 'sk_test_worker', apiBase: fake.url });
    await syncCatalog(stripe);

    // What the API does with a webhook: check the signature, record it once, queue it.
    app = createPrismaClient(database.url('app_user'));
    billingQueue = new Queue(BILLING_QUEUE, { connection: { url: redis.url } });
    const producer = new BillingProducer(billingQueue);
    const verifier = new StripeWebhookVerifier(stripe, WEBHOOK_SECRET);
    const record = new RecordStripeWebhook({
      inbox: new PrismaWebhookRecorder(app),
      jobs: { processWebhook: (eventId) => producer.stripeWebhook({ eventId }) },
    });
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const signature = String(request.headers['stripe-signature']);
        Promise.resolve()
          .then(() => record.execute(verifier.verify(Buffer.concat(chunks), signature)))
          .then(
            () => response.writeHead(200).end(),
            () => response.writeHead(500).end(),
          );
      });
    });
    await new Promise<void>((resolve) => receiver?.listen(0, '127.0.0.1', resolve));
    fake.webhookUrl = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/`;

    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      WORKER_ROLES: 'billing',
      WORKER_HEALTH_PORT: '0',
      REDIS_URL: redis.url,
      DATABASE_URL: database.url('app_user'),
      DATABASE_SYSTEM_URL: database.url('app_system'),
      APP_URL: 'http://localhost:3000/',
      STRIPE_SECRET_KEY: 'sk_test_worker',
      STRIPE_API_BASE: fake.url,
    });
    worker = await NestFactory.createApplicationContext(WorkerModule.forRoles(['billing'], env), {
      logger: false,
    });
    await worker.init();
    notifications = new Queue(NOTIFICATIONS_QUEUE, { connection: { url: redis.url } });

    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Nordlicht GmbH', now())`, [
      org,
    ]);
    await query(
      `INSERT INTO users (id, name, email, email_verified, locale, timezone, updated_at)
       VALUES ($1, 'Olivia', 'olivia@nordlicht.test', true, 'en', 'America/New_York', now())`,
      [owner],
    );
    await query(
      `INSERT INTO membership (id, organization_id, user_id, role, updated_at) VALUES ($1, $2, $3, 'OWNER', now())`,
      [randomUUID(), org, owner],
    );
    // The trial of the new organization, and the customer its first checkout stored.
    const customerId = await new StripeBillingGateway(stripe).createCustomer({
      organizationId: org,
      name: 'Nordlicht GmbH',
      email: 'olivia@nordlicht.test',
      locale: 'en',
    });
    await query(
      `INSERT INTO subscription (id, organization_id, plan_key, status, trial_ends_at, read_only_at,
                                 stripe_customer_id, updated_at)
       VALUES ($1, $2, 'trial', 'TRIALING', now() + interval '14 days', now() + interval '14 days', $3, now())`,
      [randomUUID(), org, customerId],
    );
  }, 300_000);

  afterAll(async () => {
    await notifications?.close();
    await billingQueue?.close();
    await worker?.close();
    await app?.$disconnect();
    await new Promise<void>((resolve) => {
      if (receiver) {
        receiver.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
    await fake?.close();
    await Promise.all([database?.stop(), redis?.stop()]);
  });

  it('takes over the plan of a paid checkout from the webhooks of Stripe', async () => {
    const { fake } = started();
    const gateway = new StripeBillingGateway(
      createStripeClient({ secretKey: 'sk_test_x', apiBase: fake.url }),
    );
    const [customerId] = [...fake.customers.keys()];
    await gateway.createCheckout({
      customerId: String(customerId),
      organizationId: org,
      priceLookupKey: 'smp_pro_monthly',
      locale: 'en',
      successUrl: `http://localhost:3000/org/${org}/billing?checkout=success`,
      cancelUrl: `http://localhost:3000/org/${org}/billing?checkout=canceled`,
    });
    const [session] = [...fake.checkouts.values()];

    const paid = await fake.completeCheckout(String(session?.id));
    await settled(3);

    expect(fake.webhooks.map((webhook) => [webhook.type, webhook.status])).toEqual([
      ['checkout.session.completed', 200],
      ['customer.subscription.created', 200],
      ['invoice.paid', 200],
    ]);
    const row = await subscription();
    expect(row).toMatchObject({
      plan_key: 'pro',
      status: 'ACTIVE',
      stripe_subscription_id: paid['id'],
      past_due_since: null,
      read_only_at: null,
    });
    expect(row?.billing_started_at).not.toBeNull();
    expect(row?.current_period_end?.getTime()).toBeGreaterThan(Date.now());
  });

  it('reports the AI overage and the X API costs of the paid plan to the meters, once', async () => {
    const { fake } = started();
    if (!billingQueue) {
      throw new Error('not started');
    }
    // Pro includes 30 USD of AI usage a month; 31 USD were used since the plan was bought.
    for (const quantity of [20_000_000, 11_000_000]) {
      await query(
        `INSERT INTO usage_record (id, organization_id, meter, source_type, source_id, quantity, period_start)
         VALUES (gen_random_uuid(), $1, 'ai_micros', 'ai_generation', gen_random_uuid(), $2,
                 date_trunc('month', now() AT TIME ZONE 'UTC')::date)`,
        [org, quantity],
      );
    }
    await query(
      `INSERT INTO api_cost_record (id, organization_id, platform, operation, cost_micros, source_type, source_id)
       VALUES (gen_random_uuid(), $1, 'X', 'x.post_create', 15000, 'publish_attempt', gen_random_uuid())`,
      [org],
    );
    // The report of the next day takes everything from before its midnight.
    const until = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);
    const producer = new BillingProducer(billingQueue);

    await producer.usageReport({ organizationId: org, until });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = await billingQueue.getJob(usageReportJobId(org, until));
      if (job?.finishedOn) {
        break;
      }
      await sleep(100);
    }
    // A second report of the day is the same job; the records are marked anyway.
    await producer.usageReport({ organizationId: org, until });

    const [customerId] = [...fake.customers.keys()];
    expect(fake.meterEvents).toEqual([
      {
        eventName: 'smp_ai_overage',
        identifier: `ai.${org}.${month}.${until}`,
        customerId,
        value: '1000000',
        timestamp: expect.any(Number) as unknown,
      },
      {
        eventName: 'smp_x_api_cost',
        identifier: `x.${org}.${month}.${until}`,
        customerId,
        value: '15000',
        timestamp: expect.any(Number) as unknown,
      },
    ]);
    const open = await query<{ open: number }>(
      `SELECT (SELECT count(*) FROM usage_record WHERE organization_id = $1 AND reported_to_stripe_at IS NULL)::int
            + (SELECT count(*) FROM api_cost_record WHERE organization_id = $1 AND reported_to_stripe_at IS NULL)::int
              AS open`,
      [org],
    );
    expect(open).toEqual([{ open: 0 }]);
  });

  it('starts the grace period of a failed renewal and tells the owners once', async () => {
    const { fake, notifications } = started();
    const [subscriptionId] = [...fake.subscriptions.keys()];

    const before = Date.now();
    await fake.setSubscriptionStatus(String(subscriptionId), 'past_due');
    await settled(5);

    expect(fake.webhooks.slice(3).map((webhook) => webhook.type)).toEqual([
      'invoice.payment_failed',
      'customer.subscription.updated',
    ]);
    const row = await subscription();
    expect(row).toMatchObject({ plan_key: 'pro', status: 'PAST_DUE' });
    const since = row?.past_due_since?.getTime() ?? 0;
    expect(since).toBeGreaterThanOrEqual(before - 1_000);
    expect(row?.read_only_at?.getTime()).toBe(since + 7 * DAY_MS);

    const jobs = await notifications.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job?.id).toMatch(new RegExp(`^ntf\\.evt_\\w+\\.${owner}$`));
    expect(parseNotifyDispatch(job?.data)).toEqual({
      channel: 'email',
      to: 'olivia@nordlicht.test',
      email: {
        template: 'billing-payment-failed',
        locale: 'en',
        name: 'Olivia',
        url: `http://localhost:3000/org/${org}/billing`,
        organizationName: 'Nordlicht GmbH',
        graceEndsAt: new Date(since + 7 * DAY_MS).toISOString(),
        timeZone: 'America/New_York',
      },
    });
  });

  it('makes the organization read-only at once when the subscription ends', async () => {
    const { fake } = started();
    const [subscriptionId] = [...fake.subscriptions.keys()];

    const before = Date.now();
    await fake.cancelSubscription(String(subscriptionId));
    await settled(6);

    const row = await subscription();
    expect(row).toMatchObject({ plan_key: 'pro', status: 'CANCELED' });
    // Read-only from the cancellation on, before the grace period would have ended.
    expect(row?.read_only_at?.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row?.read_only_at?.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  });
});
