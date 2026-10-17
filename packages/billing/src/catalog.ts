import type { UsageMeterName } from '@smp/core';

// The price list in Stripe (guide steps 7.1 to 7.3, ADR 0034): a product with a monthly price per
// paid plan and a metered price per usage meter, all found by their lookup keys. The plan rows of
// migration 0018 name the same keys. The amounts are placeholders: the operators set the real
// ones here and run tools/stripe-sync.ts, which creates new prices and moves the lookup keys.

export interface CatalogPlan {
  plan: 'starter' | 'pro' | 'agency';
  productId: string;
  name: string;
  lookupKey: string;
  /** Per month, net, in cents. */
  unitAmount: number;
}

export interface CatalogMeter {
  meter: UsageMeterName;
  /** The event_name of the meter events. */
  eventName: string;
  productId: string;
  name: string;
  lookupKey: string;
  /** Per micro-USD of usage, in cents with up to 12 decimals. */
  unitAmountDecimal: string;
}

export interface StripeCatalog {
  currency: string;
  /** Prices are net; Stripe Tax adds the tax of the customer's country. */
  taxBehavior: 'exclusive' | 'inclusive';
  plans: readonly CatalogPlan[];
  meters: readonly CatalogMeter[];
}

export const STRIPE_CATALOG: StripeCatalog = {
  currency: 'eur',
  taxBehavior: 'exclusive',
  plans: [
    {
      plan: 'starter',
      productId: 'smp_plan_starter',
      name: 'Starter',
      lookupKey: 'smp_starter_monthly',
      unitAmount: 1_900,
    },
    { plan: 'pro', productId: 'smp_plan_pro', name: 'Pro', lookupKey: 'smp_pro_monthly', unitAmount: 4_900 },
    {
      plan: 'agency',
      productId: 'smp_plan_agency',
      name: 'Agency',
      lookupKey: 'smp_agency_monthly',
      unitAmount: 14_900,
    },
  ],
  meters: [
    {
      meter: 'ai_overage',
      eventName: 'smp_ai_overage',
      productId: 'smp_usage_ai',
      name: 'AI usage beyond the credits of the plan',
      lookupKey: 'smp_ai_overage',
      // 1.20 EUR per USD of model costs.
      unitAmountDecimal: '0.00012',
    },
    {
      meter: 'x_api_cost',
      eventName: 'smp_x_api_cost',
      productId: 'smp_usage_x',
      name: 'Costs of the X API',
      lookupKey: 'smp_x_api_cost',
      // 1.00 EUR per USD the X API charged.
      unitAmountDecimal: '0.0001',
    },
  ],
};

export const planLookupKeys = (catalog: StripeCatalog = STRIPE_CATALOG): string[] =>
  catalog.plans.map((entry) => entry.lookupKey);

export const meteredLookupKeys = (catalog: StripeCatalog = STRIPE_CATALOG): string[] =>
  catalog.meters.map((entry) => entry.lookupKey);

export function meterOf(meter: UsageMeterName, catalog: StripeCatalog = STRIPE_CATALOG): CatalogMeter {
  const entry = catalog.meters.find((candidate) => candidate.meter === meter);
  if (!entry) {
    throw new Error(`The catalog has no meter ${meter}.`);
  }
  return entry;
}
