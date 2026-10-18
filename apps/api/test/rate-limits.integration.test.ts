import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { browser, signUpVerified } from './support/browser';

// Guide step 8.4 (ADR 0039): inbound rate limits with @nestjs/throttler, counted in Redis. Before
// the session a limit per client address, after it a limit per user across all routes. Low limits
// here; the defaults are far higher.

const PER_ADDRESS = 40;
const PER_USER = 20;

describe('inbound rate limits', () => {
  let api: ApiTestApp | undefined;

  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };

  beforeAll(async () => {
    api = await startApiTestApp({
      inboundRateLimits: { perAddressPerMinute: PER_ADDRESS, perUserPerMinute: PER_USER, routeLimits: true },
    });
  });

  afterAll(async () => {
    await api?.close();
  });

  it('limits the requests of one client address, before the session is checked', async () => {
    const client = browser(started().server, '198.51.100.20');
    for (let index = 0; index < PER_ADDRESS; index += 1) {
      await client.get('/api/me').expect(401);
    }
    const refused = await client.get('/api/me');
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'HTTP_429' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.headers['retry-after-address']).toBeUndefined();

    // Another address goes on.
    await browser(started().server, '198.51.100.21').get('/api/me').expect(401);
  });

  it('limits the requests of one user across routes and leaves other users alone', async () => {
    const busy = await signUpVerified(started(), 'busy-user@example.test');
    for (let index = 0; index < PER_USER; index += 1) {
      await (index % 2 === 0 ? busy.get('/api/me') : busy.get('/api/me/notifications')).expect(200);
    }
    await busy.get('/api/me').expect(429);

    const calm = await signUpVerified(started(), 'calm-user@example.test');
    await calm.get('/api/me').expect(200);
  });

  it('keeps the health checks out of the limit per user', async () => {
    for (let index = 0; index < PER_USER + 5; index += 1) {
      await request(started().server).get('/api/health/live').set('X-Real-IP', '198.51.100.30').expect(200);
    }
  });
});
