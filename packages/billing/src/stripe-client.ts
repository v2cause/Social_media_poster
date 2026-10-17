import Stripe from 'stripe';

// The Stripe SDK with the API version this code was written against (ADR 0034). Without a pinned
// version a newer SDK would change the shape of the objects silently.

export const STRIPE_API_VERSION = '2026-09-30.endive';

export interface StripeClientConfig {
  secretKey: string;
  /** The fake Stripe of the tests, for example http://127.0.0.1:12111. */
  apiBase?: string;
}

export function createStripeClient(config: StripeClientConfig): Stripe {
  const base = config.apiBase ? new URL(config.apiBase) : null;
  return new Stripe(config.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
    appInfo: { name: 'social-media-poster' },
    ...(base
      ? {
          host: base.hostname,
          port: base.port || (base.protocol === 'https:' ? '443' : '80'),
          protocol: base.protocol === 'https:' ? ('https' as const) : ('http' as const),
        }
      : {}),
  });
}
