import { Agent as HttpAgent, type ProxyEnv } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import Stripe from 'stripe';

// The Stripe SDK with the API version this code was written against (ADR 0034). Without a pinned
// version a newer SDK would change the shape of the objects silently.

export const STRIPE_API_VERSION = '2026-09-30.endive';

/** The client of the SDK, for the apps that hand it on without depending on the SDK. */
export type StripeClient = Stripe;

export interface StripeClientConfig {
  secretKey: string;
  /** The fake Stripe of the tests, for example http://127.0.0.1:12111. */
  apiBase?: string;
  /**
   * The egress proxy of the deployment (guide step 8.9). The SDK keeps an agent of its own and,
   * unlike fetch, ignores HTTPS_PROXY; this agent follows HTTPS_PROXY and NO_PROXY.
   */
  proxyEnv?: ProxyEnv;
}

export function createStripeClient(config: StripeClientConfig): Stripe {
  const base = config.apiBase ? new URL(config.apiBase) : null;
  const agentOptions = { keepAlive: true, proxyEnv: config.proxyEnv };
  return new Stripe(config.secretKey, {
    ...(config.proxyEnv
      ? {
          httpAgent: base?.protocol === 'http:' ? new HttpAgent(agentOptions) : new HttpsAgent(agentOptions),
        }
      : {}),
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
