import { createHash } from 'node:crypto';

import {
  INVOICE_STATUSES,
  SUBSCRIPTION_STATUSES,
  type BillingGateway,
  type CheckoutRequest,
  type InvoiceSummary,
  type PlanPrice,
  type PortalRequest,
  type ProviderSubscription,
  type SubscriptionStatus,
  type UsageMeterName,
} from '@smp/core';
import Stripe from 'stripe';

import { meteredLookupKeys, meterOf, planLookupKeys, STRIPE_CATALOG, type StripeCatalog } from './catalog';

// BillingGateway on Stripe (guide steps 7.2 and 7.3, ADR 0034). The checkout sells a plan with the
// metered prices of the usage billing and lets Stripe Tax compute the tax from the address it
// collects; a plan change moves the plan item to the new price and prorates. Prices are found by
// lookup key and stay in memory for a few minutes.

const PRICE_CACHE_MS = 5 * 60_000;
const INTERVALS = ['day', 'week', 'month', 'year'] as const;
const INVOICES_SHOWN = 24;
/** Marks the portal configuration that tools/stripe-sync.ts keeps up to date. */
export const PORTAL_CONFIGURATION_MARK = 'smp';

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);
const dateOf = (value: number | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value * 1000);
const idOf = (value: string | { id: string } | null | undefined): string | null =>
  value === null || value === undefined ? null : typeof value === 'string' ? value : value.id;

const isMissing = (error: unknown): boolean =>
  error instanceof Stripe.errors.StripeError &&
  (error.statusCode === 404 || error.code === 'resource_missing');

export function statusOf(status: Stripe.Subscription.Status): SubscriptionStatus {
  const upper = status.toUpperCase();
  const known = SUBSCRIPTION_STATUSES.find((entry) => entry === upper);
  if (!known) {
    throw new Error(`Unknown status of a Stripe subscription: ${status}`);
  }
  return known;
}

export class StripeBillingGateway implements BillingGateway {
  private readonly priceCache = new Map<string, { until: number; price: Stripe.Price }>();
  private portalConfiguration: string | null = null;

  constructor(
    private readonly stripe: Stripe,
    private readonly catalog: StripeCatalog = STRIPE_CATALOG,
  ) {}

  async createCustomer(customer: {
    organizationId: string;
    name: string;
    email: string;
    locale: 'de' | 'en';
  }): Promise<string> {
    // The same request within a day gives the same customer, so a retry never makes a second one.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([customer.name, customer.email, customer.locale]))
      .digest('hex')
      .slice(0, 16);
    const created = await this.stripe.customers.create(
      {
        name: customer.name,
        email: customer.email,
        preferred_locales: [customer.locale],
        metadata: { organizationId: customer.organizationId },
      },
      { idempotencyKey: `customer.${customer.organizationId}.${fingerprint}` },
    );
    return created.id;
  }

  async createCheckout(request: CheckoutRequest): Promise<string> {
    const plan = await this.price(request.priceLookupKey);
    const metered = await Promise.all(meteredLookupKeys(this.catalog).map((key) => this.price(key)));
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: request.customerId,
      client_reference_id: request.organizationId,
      line_items: [{ price: plan.id, quantity: 1 }, ...metered.map((price) => ({ price: price.id }))],
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      tax_id_collection: { enabled: true },
      locale: request.locale,
      metadata: { organizationId: request.organizationId },
      subscription_data: { metadata: { organizationId: request.organizationId } },
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
    });
    if (!session.url) {
      throw new Error('Stripe returned a checkout session without a URL.');
    }
    return session.url;
  }

  async createPortal(request: PortalRequest): Promise<string> {
    const configuration = await this.portalConfigurationId();
    const session = await this.stripe.billingPortal.sessions.create({
      customer: request.customerId,
      return_url: request.returnUrl,
      locale: request.locale,
      ...(configuration ? { configuration } : {}),
    });
    return session.url;
  }

  async changePlan(change: { subscriptionId: string; priceLookupKey: string }): Promise<void> {
    const subscription = await this.stripe.subscriptions.retrieve(change.subscriptionId);
    const plans = planLookupKeys(this.catalog);
    const item = subscription.items.data.find((entry) => plans.includes(entry.price.lookup_key ?? ''));
    if (!item) {
      throw new Error(`The subscription ${change.subscriptionId} has no plan item.`);
    }
    const price = await this.price(change.priceLookupKey);
    await this.stripe.subscriptions.update(change.subscriptionId, {
      items: [{ id: item.id, price: price.id }],
      proration_behavior: 'create_prorations',
    });
  }

  async fetchSubscription(subscriptionId: string): Promise<ProviderSubscription | null> {
    let subscription: Stripe.Subscription;
    try {
      subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
    const plans = planLookupKeys(this.catalog);
    const items = subscription.items.data;
    const planItem = items.find((entry) => plans.includes(entry.price.lookup_key ?? '')) ?? items[0];
    const customerId = idOf(subscription.customer);
    if (!customerId) {
      throw new Error(`The subscription ${subscriptionId} has no customer.`);
    }
    return {
      id: subscription.id,
      customerId,
      status: statusOf(subscription.status),
      priceLookupKeys: items.flatMap((entry) => (entry.price.lookup_key ? [entry.price.lookup_key] : [])),
      currentPeriodStart: dateOf(planItem?.current_period_start),
      currentPeriodEnd: dateOf(planItem?.current_period_end),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      startedAt: new Date(subscription.start_date * 1000),
      trialEnd: dateOf(subscription.trial_end),
    };
  }

  async listInvoices(customerId: string): Promise<InvoiceSummary[]> {
    const invoices = await this.stripe.invoices.list({ customer: customerId, limit: INVOICES_SHOWN });
    return invoices.data.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      status: INVOICE_STATUSES.find((status) => status === invoice.status) ?? null,
      total: invoice.total,
      currency: invoice.currency,
      createdAt: new Date(invoice.created * 1000),
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      pdfUrl: invoice.invoice_pdf ?? null,
    }));
  }

  async prices(lookupKeys: readonly string[]): Promise<PlanPrice[]> {
    const prices = await Promise.all(lookupKeys.map((key) => this.price(key).catch(() => null)));
    return prices.flatMap((price) => {
      const interval = INTERVALS.find((entry) => entry === price?.recurring?.interval);
      return price?.lookup_key && price.unit_amount !== null && interval
        ? [{ lookupKey: price.lookup_key, unitAmount: price.unit_amount, currency: price.currency, interval }]
        : [];
    });
  }

  async reportUsage(event: {
    meter: UsageMeterName;
    customerId: string;
    value: bigint;
    identifier: string;
    timestamp: Date;
  }): Promise<void> {
    await this.stripe.billing.meterEvents.create({
      event_name: meterOf(event.meter, this.catalog).eventName,
      identifier: event.identifier,
      timestamp: seconds(event.timestamp),
      payload: { stripe_customer_id: event.customerId, value: event.value.toString() },
    });
  }

  /** The active price with a lookup key; throws when Stripe has none. */
  private async price(lookupKey: string): Promise<Stripe.Price> {
    const cached = this.priceCache.get(lookupKey);
    if (cached && cached.until > Date.now()) {
      return cached.price;
    }
    const { data } = await this.stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const price = data[0];
    if (!price) {
      throw new Error(
        `Stripe has no active price with the lookup key ${lookupKey}; run tools/stripe-sync.ts.`,
      );
    }
    this.priceCache.set(lookupKey, { until: Date.now() + PRICE_CACHE_MS, price });
    return price;
  }

  /** The portal configuration of tools/stripe-sync.ts, or null for the default of the account. */
  private async portalConfigurationId(): Promise<string | null> {
    if (this.portalConfiguration) {
      return this.portalConfiguration;
    }
    const { data } = await this.stripe.billingPortal.configurations.list({ active: true, limit: 100 });
    const ours = data.find(
      (configuration) => configuration.metadata?.['managedBy'] === PORTAL_CONFIGURATION_MARK,
    );
    this.portalConfiguration = ours?.id ?? null;
    return this.portalConfiguration;
  }
}
