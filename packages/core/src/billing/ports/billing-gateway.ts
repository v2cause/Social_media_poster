import type { SubscriptionStatus } from '../domain/subscription';

// The payment provider (guide step 7.2, ADR 0034): Stripe in production, a stand-in in the tests.
// Checkout and customer portal are pages of the provider; the state of a paid subscription is
// read from it after every webhook, so the order of the webhooks does not matter.

/** A subscription as the provider has it, reduced to what billing needs. */
export interface ProviderSubscription {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  /** The lookup keys of its prices; the plan is the one whose key is among them. */
  priceLookupKeys: string[];
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  startedAt: Date;
  /** A trial the provider runs itself. */
  trialEnd: Date | null;
}

export interface PlanPrice {
  lookupKey: string;
  /** In the minor unit of the currency. */
  unitAmount: number;
  currency: string;
  interval: 'day' | 'week' | 'month' | 'year';
}

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface InvoiceSummary {
  id: string;
  number: string | null;
  status: InvoiceStatus | null;
  /** In the minor unit of the currency, taxes included. */
  total: number;
  currency: string;
  createdAt: Date;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
}

/** The meters of the usage billing (guide step 7.3), both in micro-USD. */
export const USAGE_METER_NAMES = ['ai_overage', 'x_api_cost'] as const;
export type UsageMeterName = (typeof USAGE_METER_NAMES)[number];

export interface CheckoutRequest {
  customerId: string;
  organizationId: string;
  priceLookupKey: string;
  locale: 'de' | 'en';
  successUrl: string;
  cancelUrl: string;
}

export interface PortalRequest {
  customerId: string;
  locale: 'de' | 'en';
  returnUrl: string;
}

export interface BillingGateway {
  /** A customer for the organization; the same organization never gets a second one. */
  createCustomer(customer: {
    organizationId: string;
    name: string;
    email: string;
    locale: 'de' | 'en';
  }): Promise<string>;
  /** The URL of the hosted checkout of a plan with its metered prices and automatic tax. */
  createCheckout(request: CheckoutRequest): Promise<string>;
  /** The URL of the customer portal: payment methods, invoices, addresses and cancellation. */
  createPortal(request: PortalRequest): Promise<string>;
  /** Moves the plan item of a subscription to another price; the provider prorates it. */
  changePlan(change: { subscriptionId: string; priceLookupKey: string }): Promise<void>;
  /** Lets a subscription end with its period, or renew again (guide step 8.2). */
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<void>;
  /**
   * Deletes a customer for good, which ends its subscriptions at once (guide step 8.2). A customer
   * the provider does not know any more counts as deleted.
   */
  deleteCustomer(customerId: string): Promise<void>;
  /** Null when the provider does not know the subscription. */
  fetchSubscription(subscriptionId: string): Promise<ProviderSubscription | null>;
  /** The latest invoices of a customer, newest first. */
  listInvoices(customerId: string): Promise<InvoiceSummary[]>;
  /** The active prices with these lookup keys. */
  prices(lookupKeys: readonly string[]): Promise<PlanPrice[]>;
  /**
   * Reports usage to a meter. The identifier makes a repeated report count once while the
   * provider remembers it (at least 24 hours).
   */
  reportUsage(event: {
    meter: UsageMeterName;
    customerId: string;
    value: bigint;
    identifier: string;
    timestamp: Date;
  }): Promise<void>;
}

/** The webhook events billing handles (guide step 7.2). */
export const BILLING_WEBHOOK_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;
export type BillingWebhookType = (typeof BILLING_WEBHOOK_TYPES)[number];

/** A webhook whose signature was checked, reduced to the ids billing needs. */
export interface BillingWebhookEvent {
  id: string;
  type: string;
  createdAt: Date;
  /** The subscription the event concerns, if it names one. */
  subscriptionId: string | null;
  customerId: string | null;
}

/** Checks the signature against the raw body; throws WebhookSignatureInvalidError otherwise. */
export interface BillingWebhookVerifier {
  verify(rawBody: Uint8Array, signature: string): BillingWebhookEvent;
}
