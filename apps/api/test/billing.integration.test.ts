import type { AddressInfo } from 'node:net';

import { createStripeClient, planLookupKeys, syncCatalog } from '@smp/billing';
import { BILLING_QUEUE } from '@smp/queue';
import { FakeStripe, stripeSignature } from '@smp/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { signUpVerified, type Browser } from './support/browser';

// Guide steps 7.2 and 7.5 through the API against the fake Stripe: the owner sees plan, usage and
// prices, opens the checkout of a plan and the customer portal, Stripe reports the payment with
// signed webhooks, and each event is recorded once and queued for the role "billing". Nothing
// here changes the plan; the worker does.

const WEBHOOK_SECRET = 'whsec_test_billing_api';

describe('billing API', () => {
  let api: ApiTestApp | undefined;
  let fake: FakeStripe | undefined;
  let owner: Browser;
  let organizationId = '';

  const started = () => {
    if (!api || !fake) {
      throw new Error('not started');
    }
    return { api, fake };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().api.database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    fake = await FakeStripe.start({ webhookSecret: WEBHOOK_SECRET });
    api = await startApiTestApp({
      env: {
        STRIPE_SECRET_KEY: 'sk_test_api',
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STRIPE_API_BASE: fake.url,
      },
    });
    // Stripe delivers to the listening API.
    await new Promise<void>((resolve) => api?.server.listen(0, '127.0.0.1', resolve));
    const { port } = api.server.address() as AddressInfo;
    fake.webhookUrl = `http://127.0.0.1:${String(port)}/api/webhooks/stripe`;
    await syncCatalog(createStripeClient({ secretKey: 'sk_test_sync', apiBase: fake.url }));

    owner = await signUpVerified(api, 'billing-owner@acme.test', 'Bea Owner');
    const created = await owner
      .post('/api/organizations')
      .send({ name: 'Billing GmbH', workspace: { name: 'Billing', timezone: 'UTC', contentLanguage: 'de' } })
      .expect(201);
    organizationId = (created.body as { organizationId: string }).organizationId;
  });

  afterAll(async () => {
    await api?.close();
    await fake?.close();
  });

  it('sells the plans of the price list under the lookup keys of the catalog', async () => {
    const rows = await query<{ price_lookup_key: string }>(
      'SELECT price_lookup_key FROM plan WHERE price_lookup_key IS NOT NULL ORDER BY position',
    );
    expect(rows.map((row) => row.price_lookup_key)).toEqual(planLookupKeys());
  });

  it('shows the trial with the usage of every limit and the prices of the plans', async () => {
    const response = await owner.get(`/api/org/${organizationId}/billing`).expect(200);
    const today = new Date();

    expect(response.body).toMatchObject({
      plan: { key: 'trial', limits: { maxWorkspaces: 1, maxMembers: 3 }, price: null },
      status: 'TRIALING',
      access: 'full',
      graceEndsAt: null,
      readOnlySince: null,
      cancelAtPeriodEnd: false,
      billingEnabled: true,
      hasRunningSubscription: false,
      hasCustomer: false,
      periodStart: `${today.toISOString().slice(0, 7)}-01`,
      usage: {
        workspaces: { used: 1, limit: 1 },
        members: { used: 1, limit: 3 },
        socialAccounts: { used: 0, limit: 3 },
        scheduledPosts: { used: 0, limit: 30 },
        storageBytes: { used: 0, limit: 1024 ** 3 },
        xApiMicros: { used: 0, limit: 1_000_000 },
        ai: { usedMicros: 0, includedMicros: 2_000_000, overageCapMicros: 0 },
      },
    });
    const body = response.body as {
      trialEndsAt: string;
      plans: { key: string; price: { unitAmount: number; currency: string; interval: string } | null }[];
    };
    // Fourteen days of trial from the sign-up.
    expect(Date.parse(body.trialEndsAt) - today.getTime()).toBeGreaterThan(13 * 24 * 60 * 60 * 1000);
    expect(body.plans.map((plan) => [plan.key, plan.price])).toEqual([
      ['trial', null],
      ['starter', { unitAmount: 1_900, currency: 'eur', interval: 'month' }],
      ['pro', { unitAmount: 4_900, currency: 'eur', interval: 'month' }],
      ['agency', { unitAmount: 14_900, currency: 'eur', interval: 'month' }],
    ]);

    // Every member sees the state of the subscription with the organization.
    const context = await owner.get(`/api/org/${organizationId}`).expect(200);
    expect(context.body).toMatchObject({
      billing: { access: 'full', status: 'TRIALING', trialEndsAt: body.trialEndsAt, graceEndsAt: null },
    });
  });

  it('opens the checkout of a plan for a customer made once from the owner', async () => {
    const { fake } = started();

    const first = await owner
      .post(`/api/org/${organizationId}/billing/checkout`)
      .send({ plan: 'pro' })
      .expect(201);
    await owner.post(`/api/org/${organizationId}/billing/checkout`).send({ plan: 'starter' }).expect(201);

    expect((first.body as { url: string }).url).toMatch(new RegExp(`^${fake.url}/checkout/`));
    expect([...fake.customers.values()]).toEqual([
      expect.objectContaining({
        email: 'billing-owner@acme.test',
        name: 'Billing GmbH',
        metadata: { organizationId },
      }),
    ]);
    const [subscription] = await query<{ stripe_customer_id: string; plan_key: string; status: string }>(
      'SELECT stripe_customer_id, plan_key, status FROM subscription WHERE organization_id = $1',
      [organizationId],
    );
    expect(subscription).toEqual({
      stripe_customer_id: [...fake.customers.keys()][0],
      plan_key: 'trial',
      status: 'TRIALING',
    });
    await owner.post(`/api/org/${organizationId}/billing/checkout`).send({ plan: 'trial' }).expect(400);
  });

  it('records the signed webhooks of a payment once and queues each for the role "billing"', async () => {
    const { api, fake } = started();
    const [session] = [...fake.checkouts.values()];

    await fake.completeCheckout(String(session?.id));

    expect(fake.webhooks.map((webhook) => [webhook.type, webhook.status])).toEqual([
      ['checkout.session.completed', 200],
      ['customer.subscription.created', 200],
      ['invoice.paid', 200],
    ]);
    const events = await query<{
      external_id: string;
      type: string;
      payload: unknown;
      processed_at: Date | null;
    }>(
      `SELECT external_id, type, payload, processed_at FROM webhook_event WHERE provider = 'stripe' ORDER BY received_at`,
    );
    const subscriptionId = [...fake.subscriptions.keys()][0];
    expect(events.map((event) => [event.type, event.payload, event.processed_at])).toEqual([
      ['checkout.session.completed', { subscriptionId, customerId: session?.['customer'] }, null],
      ['customer.subscription.created', { subscriptionId, customerId: session?.['customer'] }, null],
      ['invoice.paid', { subscriptionId, customerId: session?.['customer'] }, null],
    ]);
    const queue = new Queue(BILLING_QUEUE, { connection: { url: api.env.REDIS_URL } });
    try {
      for (const event of events) {
        expect(await queue.getJob(`stripe.${event.external_id}`), event.type).toBeDefined();
      }
      // Stripe sends again until it hears back; the event stays one.
      const [first] = events;
      const payload = JSON.stringify({
        id: first?.external_id,
        object: 'event',
        type: first?.type,
        created: 1_760_000_000,
        data: {
          object: {
            id: session?.id,
            object: 'checkout.session',
            customer: session?.['customer'],
            subscription: subscriptionId,
          },
        },
      });
      await request(api.server)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', stripeSignature(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000)))
        .send(payload)
        .expect(200, { received: true });
      expect(await query('SELECT id FROM webhook_event')).toHaveLength(3);
      expect(await queue.getJobCounts('waiting', 'delayed', 'active')).toMatchObject({ waiting: 3 });
    } finally {
      await queue.close();
    }
    // The plan changes with the worker, not with the webhook.
    const [subscription] = await query<{ plan_key: string }>(
      'SELECT plan_key FROM subscription WHERE organization_id = $1',
      [organizationId],
    );
    expect(subscription?.plan_key).toBe('trial');
  });

  it('refuses webhooks without a valid signature and ignores the types billing does not handle', async () => {
    const { api } = started();
    const payload = JSON.stringify({
      id: 'evt_forged',
      object: 'event',
      type: 'invoice.paid',
      created: 1,
      data: { object: {} },
    });
    const now = Math.floor(Date.now() / 1000);

    const forged = await request(api.server)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', stripeSignature(payload, 'whsec_forged', now))
      .send(payload)
      .expect(422);
    expect(forged.body).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    await request(api.server)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(422);

    const other = JSON.stringify({
      id: 'evt_other',
      object: 'event',
      type: 'customer.created',
      created: 1,
      data: { object: { object: 'customer' } },
    });
    await request(api.server)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', stripeSignature(other, WEBHOOK_SECRET, now))
      .send(other)
      .expect(200);
    expect(
      await query(`SELECT id FROM webhook_event WHERE external_id IN ('evt_forged', 'evt_other')`),
    ).toEqual([]);
  });

  it('opens the customer portal and lists the invoices of the customer', async () => {
    const { fake } = started();

    const portal = await owner.post(`/api/org/${organizationId}/billing/portal`).expect(201);
    expect((portal.body as { url: string }).url).toMatch(new RegExp(`^${fake.url}/portal/`));

    const invoices = await owner.get(`/api/org/${organizationId}/billing/invoices`).expect(200);
    expect(invoices.body).toEqual({
      items: [
        expect.objectContaining({
          status: 'paid',
          currency: 'eur',
          total: 4_900,
          number: 'FAKE-0001',
        }) as unknown,
      ],
    });
  });

  it('asks for a checkout before a plan change while no paid subscription runs here', async () => {
    const response = await owner
      .post(`/api/org/${organizationId}/billing/plan`)
      .send({ plan: 'agency' })
      .expect(409);
    expect(response.body).toMatchObject({ code: 'BILLING_CUSTOMER_MISSING' });
  });
});
