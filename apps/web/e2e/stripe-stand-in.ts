import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createStripeClient, syncCatalog } from '@smp/billing';
import { FakeStripe } from '@smp/testing';

// The fake Stripe of the billing test (guide step 7.5) on the address the stack runs with
// (STRIPE_API_BASE): the API and the worker role "billing" talk to it, it posts its signed webhooks
// to the API, and the test plays the customer and Stripe with it. It accepts test keys only.

export interface StripeSettings {
  secretKey: string;
  webhookSecret: string;
  apiBase: string;
  /** Where the webhooks go: the API itself, not through the web app. */
  apiUrl: string;
}

/** A setting from the environment, else from the root .env the stack runs with. */
function setting(name: string): string | undefined {
  const fromEnvironment = process.env[name];
  if (fromEnvironment) {
    return fromEnvironment;
  }
  let file: string;
  try {
    file = readFileSync(resolve(__dirname, '../../../.env'), 'utf8');
  } catch {
    return undefined;
  }
  const line = file.split('\n').find((entry) => entry.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || undefined;
}

/** Null while the stack runs without the fake Stripe; the billing test is skipped then. */
export function stripeSettings(): StripeSettings | null {
  const secretKey = setting('STRIPE_SECRET_KEY');
  const webhookSecret = setting('STRIPE_WEBHOOK_SECRET');
  const apiBase = setting('STRIPE_API_BASE');
  if (!secretKey?.startsWith('sk_test_') || !webhookSecret || !apiBase) {
    return null;
  }
  return {
    secretKey,
    webhookSecret,
    apiBase,
    apiUrl: setting('API_INTERNAL_URL') ?? 'http://127.0.0.1:3001',
  };
}

/** Starts the fake on the port of STRIPE_API_BASE with the prices and meters of the catalog. */
export async function startStripeStandIn(settings: StripeSettings): Promise<FakeStripe> {
  const fake = await FakeStripe.start({
    webhookSecret: settings.webhookSecret,
    webhookUrl: `${settings.apiUrl}/api/webhooks/stripe`,
    port: Number(new URL(settings.apiBase).port),
  });
  await syncCatalog(createStripeClient({ secretKey: settings.secretKey, apiBase: fake.url }));
  return fake;
}
