import { startConnectRecorder, type ConnectRecorder } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStripeClient } from './stripe-client';

// Guide step 8.9: in production API and worker reach the internet only through the egress proxy.
// The SDK of Stripe ignores HTTPS_PROXY with an agent of its own, so it gets the proxy settings.

describe('createStripeClient', () => {
  let proxy: ConnectRecorder | undefined;

  beforeAll(async () => {
    proxy = await startConnectRecorder();
  });

  afterAll(async () => {
    await proxy?.stop();
  });

  it('opens its connections to Stripe through the egress proxy', async () => {
    const recorder = proxy;
    if (!recorder) {
      throw new Error('The proxy did not start.');
    }
    const stripe = createStripeClient({
      secretKey: 'sk_test_proxy',
      proxyEnv: { HTTPS_PROXY: recorder.url },
    });

    await expect(stripe.balance.retrieve()).rejects.toThrow();
    expect(recorder.tunnels).toContain('api.stripe.com:443');
  });
});
