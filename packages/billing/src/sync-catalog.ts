import Stripe from 'stripe';

import { STRIPE_CATALOG, type StripeCatalog } from './catalog';
import { PORTAL_CONFIGURATION_MARK } from './stripe-gateway';

// Brings the price list in Stripe in line with the catalog (guide step 7.2, tools/stripe-sync.ts):
// the meters of the usage billing, a product per plan and meter, a price per lookup key and the
// portal configuration. It runs again without harm: what matches stays, a changed amount gets a
// new price that takes over the lookup key, because prices cannot change their amount.

export interface SyncReport {
  created: string[];
  updated: string[];
  unchanged: string[];
}

export interface SyncOptions {
  catalog?: StripeCatalog;
  /** Shown in the customer portal. */
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
}

const MARK = { managedBy: PORTAL_CONFIGURATION_MARK };

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'statusCode' in error && error.statusCode === 404;

export async function syncCatalog(stripe: Stripe, options: SyncOptions = {}): Promise<SyncReport> {
  const catalog = options.catalog ?? STRIPE_CATALOG;
  const report: SyncReport = { created: [], updated: [], unchanged: [] };

  // Meters, found by their event name.
  const meters = (await stripe.billing.meters.list({ status: 'active', limit: 100 })).data;
  const meterIds = new Map<string, string>();
  for (const entry of catalog.meters) {
    const existing = meters.find((meter) => meter.event_name === entry.eventName);
    if (existing) {
      meterIds.set(entry.eventName, existing.id);
      report.unchanged.push(`meter ${entry.eventName}`);
      continue;
    }
    const meter = await stripe.billing.meters.create({
      display_name: entry.name,
      event_name: entry.eventName,
      default_aggregation: { formula: 'sum' },
      customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
      value_settings: { event_payload_key: 'value' },
    });
    meterIds.set(entry.eventName, meter.id);
    report.created.push(`meter ${entry.eventName}`);
  }

  // Products with fixed ids.
  for (const entry of [...catalog.plans, ...catalog.meters]) {
    let product: Stripe.Product | null = null;
    try {
      product = await stripe.products.retrieve(entry.productId);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    if (!product) {
      await stripe.products.create({ id: entry.productId, name: entry.name, metadata: MARK });
      report.created.push(`product ${entry.productId}`);
    } else if (product.name !== entry.name) {
      await stripe.products.update(entry.productId, { name: entry.name });
      report.updated.push(`product ${entry.productId}`);
    } else {
      report.unchanged.push(`product ${entry.productId}`);
    }
  }

  // Prices by lookup key; a different amount needs a new price.
  const lookupKeys = [...catalog.plans, ...catalog.meters].map((entry) => entry.lookupKey);
  const prices = (await stripe.prices.list({ lookup_keys: lookupKeys, active: true, limit: 100 })).data;
  for (const entry of catalog.plans) {
    const current = prices.find((price) => price.lookup_key === entry.lookupKey);
    if (
      current &&
      current.product === entry.productId &&
      current.currency === catalog.currency &&
      current.unit_amount === entry.unitAmount &&
      current.recurring?.interval === 'month' &&
      current.recurring.usage_type === 'licensed'
    ) {
      report.unchanged.push(`price ${entry.lookupKey}`);
      continue;
    }
    await stripe.prices.create({
      product: entry.productId,
      currency: catalog.currency,
      unit_amount: entry.unitAmount,
      recurring: { interval: 'month', usage_type: 'licensed' },
      tax_behavior: catalog.taxBehavior,
      lookup_key: entry.lookupKey,
      transfer_lookup_key: true,
      nickname: `${entry.name} monthly`,
      metadata: MARK,
    });
    report[current ? 'updated' : 'created'].push(`price ${entry.lookupKey}`);
  }
  for (const entry of catalog.meters) {
    const meter = meterIds.get(entry.eventName);
    const current = prices.find((price) => price.lookup_key === entry.lookupKey);
    if (
      current &&
      current.product === entry.productId &&
      current.currency === catalog.currency &&
      current.unit_amount_decimal?.eq(Stripe.Decimal.from(entry.unitAmountDecimal)) === true &&
      current.recurring?.usage_type === 'metered' &&
      current.recurring.meter === meter
    ) {
      report.unchanged.push(`price ${entry.lookupKey}`);
      continue;
    }
    await stripe.prices.create({
      product: entry.productId,
      currency: catalog.currency,
      unit_amount_decimal: Stripe.Decimal.from(entry.unitAmountDecimal),
      billing_scheme: 'per_unit',
      recurring: { interval: 'month', usage_type: 'metered', ...(meter ? { meter } : {}) },
      tax_behavior: catalog.taxBehavior,
      lookup_key: entry.lookupKey,
      transfer_lookup_key: true,
      nickname: entry.name,
      metadata: MARK,
    });
    report[current ? 'updated' : 'created'].push(`price ${entry.lookupKey}`);
  }

  // The customer portal: payment methods, invoices, addresses and the cancellation at the end of
  // the period. Plans change in the app (ChangePlan), not in the portal.
  const features = {
    customer_update: { enabled: true, allowed_updates: ['email', 'address', 'name', 'tax_id'] as const },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: 'at_period_end' as const },
    subscription_update: { enabled: false },
  };
  const businessProfile = {
    ...(options.privacyPolicyUrl ? { privacy_policy_url: options.privacyPolicyUrl } : {}),
    ...(options.termsOfServiceUrl ? { terms_of_service_url: options.termsOfServiceUrl } : {}),
  };
  const configurations = (await stripe.billingPortal.configurations.list({ active: true, limit: 100 })).data;
  const ours = configurations.find(
    (configuration) => configuration.metadata?.['managedBy'] === MARK.managedBy,
  );
  const configuration = {
    features: {
      ...features,
      customer_update: {
        ...features.customer_update,
        allowed_updates: [...features.customer_update.allowed_updates],
      },
    },
    ...(Object.keys(businessProfile).length > 0 ? { business_profile: businessProfile } : {}),
    metadata: MARK,
  };
  if (ours) {
    await stripe.billingPortal.configurations.update(ours.id, configuration);
    report.updated.push('portal configuration');
  } else {
    await stripe.billingPortal.configurations.create(configuration);
    report.created.push('portal configuration');
  }
  return report;
}
