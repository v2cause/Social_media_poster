import { WebhookSignatureInvalidError } from '@smp/core';
import { FakeStripe, stripeSignature } from '@smp/testing';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { STRIPE_CATALOG } from './catalog';
import { billingEnvSchema, checkBillingEnv } from './env';
import { createStripeClient } from './stripe-client';
import { StripeBillingGateway } from './stripe-gateway';
import { syncCatalog } from './sync-catalog';
import { StripeWebhookVerifier } from './webhook-verifier';

// Guide steps 7.2 and 7.3 against the fake Stripe, which checks every parameter against the
// official API spec: the sync of the price list, checkout, plan change, portal, invoices, meter
// events and the signature of the webhooks.

const SECRET = 'whsec_test_gateway';
const ORG = '0192f000-0000-7000-8000-000000000001';

describe('Stripe billing against the fake Stripe', () => {
  let fake: FakeStripe | undefined;
  let stripe: Stripe | undefined;

  const started = () => {
    if (!fake || !stripe) {
      throw new Error('not started');
    }
    return { fake, stripe, gateway: new StripeBillingGateway(stripe) };
  };

  beforeAll(async () => {
    fake = await FakeStripe.start({ webhookSecret: SECRET });
    stripe = createStripeClient({ secretKey: 'sk_test_gateway', apiBase: fake.url });
  });

  afterAll(async () => {
    await fake?.close();
  });

  it('creates the price list once and changes only what differs', async () => {
    const { stripe, fake } = started();

    const first = await syncCatalog(stripe, { privacyPolicyUrl: 'https://app.example.test/privacy' });
    expect(first.created).toEqual(
      expect.arrayContaining([
        'meter smp_ai_overage',
        'meter smp_x_api_cost',
        'product smp_plan_pro',
        'price smp_starter_monthly',
        'price smp_ai_overage',
        'portal configuration',
      ]),
    );
    const again = await syncCatalog(stripe);
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual(['portal configuration']);

    const cheaper = {
      ...STRIPE_CATALOG,
      plans: STRIPE_CATALOG.plans.map((plan) =>
        plan.plan === 'pro' ? { ...plan, unitAmount: 3_900 } : plan,
      ),
    };
    const changed = await syncCatalog(stripe, { catalog: cheaper });
    expect(changed.updated).toContain('price smp_pro_monthly');
    const pro = [...fake.prices.values()].filter((price) => price['product'] === 'smp_plan_pro');
    expect(pro.map((price) => [price['unit_amount'], price['lookup_key']])).toEqual([
      [4_900, null],
      [3_900, 'smp_pro_monthly'],
    ]);
    await syncCatalog(stripe);
  });

  it('makes one customer per organization and opens a checkout with tax and the metered prices', async () => {
    const { gateway, fake } = started();
    const customer = {
      organizationId: ORG,
      name: 'Acme',
      email: 'owner@example.test',
      locale: 'de' as const,
    };

    const customerId = await gateway.createCustomer(customer);
    expect(await gateway.createCustomer(customer)).toBe(customerId);
    expect(fake.customers.size).toBe(1);

    const url = await gateway.createCheckout({
      customerId,
      organizationId: ORG,
      priceLookupKey: 'smp_pro_monthly',
      locale: 'de',
      successUrl: 'https://app.example.test/billing?checkout=success',
      cancelUrl: 'https://app.example.test/billing?checkout=canceled',
    });

    expect(url).toMatch(new RegExp(`^${fake.url}/checkout/cs_test_`));
    const [request] = fake.requestsTo('POST /v1/checkout/sessions');
    expect(request?.params).toMatchObject({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: ORG,
      automatic_tax: { enabled: 'true' },
      tax_id_collection: { enabled: 'true' },
      customer_update: { address: 'auto', name: 'auto' },
      locale: 'de',
    });
    const lines = (request?.params['line_items'] ?? []) as Record<string, string>[];
    expect(lines.map((line) => line['quantity'] ?? null)).toEqual(['1', null, null]);
  });

  it('reads the subscription after the checkout, moves its plan and lists the invoice', async () => {
    const { gateway, fake } = started();
    const [session] = [...fake.checkouts.values()];
    const subscription = await fake.completeCheckout(String(session?.id));

    const reported = await gateway.fetchSubscription(String(subscription['id']));
    expect(reported).toMatchObject({
      status: 'ACTIVE',
      customerId: session?.['customer'],
      cancelAtPeriodEnd: false,
      trialEnd: null,
    });
    expect(reported?.priceLookupKeys).toEqual(['smp_pro_monthly', 'smp_ai_overage', 'smp_x_api_cost']);
    expect(reported?.currentPeriodEnd?.getTime()).toBeGreaterThan(Date.now());

    await gateway.changePlan({
      subscriptionId: String(subscription['id']),
      priceLookupKey: 'smp_agency_monthly',
    });
    expect((await gateway.fetchSubscription(String(subscription['id'])))?.priceLookupKeys).toEqual([
      'smp_agency_monthly',
      'smp_ai_overage',
      'smp_x_api_cost',
    ]);
    expect(fake.requestsTo('POST /v1/subscriptions/{subscription_exposed_id}')[0]?.params).toMatchObject({
      proration_behavior: 'create_prorations',
    });

    const invoices = await gateway.listInvoices(String(session?.customer));
    expect(invoices).toEqual([
      expect.objectContaining({ status: 'paid', currency: 'eur', total: 4_900, number: 'FAKE-0001' }),
    ]);
    await expect(gateway.fetchSubscription('sub_unknown')).resolves.toBeNull();
  });

  it('opens the portal with the configuration of the sync and reads the prices', async () => {
    const { gateway, fake } = started();
    const customerId = String([...fake.customers.keys()][0]);

    const url = await gateway.createPortal({
      customerId,
      locale: 'en',
      returnUrl: 'https://app.example.test/billing',
    });

    expect(url).toMatch(new RegExp(`^${fake.url}/portal/`));
    const configuration = [...fake.portalConfigurations.values()][0];
    expect(fake.requestsTo('POST /v1/billing_portal/sessions')[0]?.params).toMatchObject({
      configuration: configuration?.['id'],
      customer: customerId,
    });
    await expect(gateway.prices(['smp_starter_monthly', 'smp_unknown'])).resolves.toEqual([
      { lookupKey: 'smp_starter_monthly', unitAmount: 1_900, currency: 'eur', interval: 'month' },
    ]);
  });

  it('reports usage to the meters, once per identifier', async () => {
    const { gateway, fake } = started();
    const customerId = String([...fake.customers.keys()][0]);
    const event = {
      meter: 'ai_overage' as const,
      customerId,
      value: 1_250_000n,
      identifier: 'ai.org.2026-10-01.2026-10-17',
      timestamp: new Date('2026-10-16T23:59:59Z'),
    };

    await gateway.reportUsage(event);
    await gateway.reportUsage(event);

    expect(fake.meterEvents).toEqual([
      {
        eventName: 'smp_ai_overage',
        identifier: 'ai.org.2026-10-01.2026-10-17',
        customerId,
        value: '1250000',
        timestamp: Date.parse('2026-10-16T23:59:59Z') / 1000,
      },
    ]);
  });

  it('checks the signature of a webhook and keeps only its ids', () => {
    const { stripe } = started();
    const verifier = new StripeWebhookVerifier(stripe, SECRET);
    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'invoice.payment_failed',
      created: 1_760_000_000,
      data: {
        object: {
          id: 'in_1',
          object: 'invoice',
          customer: 'cus_1',
          customer_address: { line1: 'Musterstr. 1' },
          parent: { subscription_details: { subscription: 'sub_1' } },
        },
      },
    });
    const now = Math.floor(Date.now() / 1000);

    expect(verifier.verify(Buffer.from(payload), stripeSignature(payload, SECRET, now))).toEqual({
      id: 'evt_1',
      type: 'invoice.payment_failed',
      createdAt: new Date(1_760_000_000 * 1000),
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
    });
    expect(() =>
      verifier.verify(Buffer.from(payload), stripeSignature(payload, 'whsec_forged', now)),
    ).toThrow(WebhookSignatureInvalidError);
    expect(() => verifier.verify(Buffer.from(`${payload} `), stripeSignature(payload, SECRET, now))).toThrow(
      WebhookSignatureInvalidError,
    );
    // Stripe refuses replays older than five minutes.
    expect(() => verifier.verify(Buffer.from(payload), stripeSignature(payload, SECRET, now - 600))).toThrow(
      WebhookSignatureInvalidError,
    );
  });
});

describe('the configuration of Stripe', () => {
  const parse = (env: Record<string, string>) =>
    billingEnvSchema
      .extend({ NODE_ENV: z.string() })
      .superRefine(checkBillingEnv)
      .safeParse({ NODE_ENV: 'development', ...env });

  it('sends test keys only to a fake and never runs a fake in production', () => {
    expect(
      parse({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_API_BASE: 'http://127.0.0.1:12111' }).success,
    ).toBe(true);
    expect(
      parse({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_API_BASE: 'http://127.0.0.1:12111' }).success,
    ).toBe(false);
    expect(parse({ NODE_ENV: 'production', STRIPE_API_BASE: 'http://127.0.0.1:12111' }).success).toBe(false);
    expect(parse({ STRIPE_SECRET_KEY: 'pk_test_public' }).success).toBe(false);
    expect(parse({ STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' }).success).toBe(true);
  });
});
