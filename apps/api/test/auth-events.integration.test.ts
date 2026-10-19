import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { accountDigest } from '../src/modules/identity/auth-hooks';
import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { browser, PASSWORD, verificationLink } from './support/browser';

// Guide step 8.7 (ADR 0039, ASVS 16.3.1): every step of signing up, in and out leaves auth.event
// in the log with the path, the outcome, the code of a failure and the user or, before the user is
// known, a digest of the address. A redirect of the verification link counts as a failure only
// when it names an error. Neither the address nor the password appears in the log.

const WRONG_PASSWORD = 'wrong password 123';

describe('auth events', () => {
  let api: ApiTestApp | undefined;
  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };
  /** The auth events logged since the spy started. */
  const events = (log: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
    log.mock.calls
      .filter((call) => call[1] === 'auth.event')
      .map((call) => call[0] as Record<string, unknown>);

  beforeAll(async () => {
    api = await startApiTestApp();
  });

  afterAll(async () => {
    await api?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs sign-up, a failed and a good verification, a failed and a good sign-in and the sign-out', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const email = 'ada@auth-events.test';
    const agent = browser(started().server, '198.51.100.70');

    await agent
      .post('/api/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Ada Lovelace', callbackURL: '/onboarding' })
      .expect(200);
    await agent.get('/api/auth/verify-email?token=not-a-token&callbackURL=%2Fonboarding').expect(302);
    await agent.get(await verificationLink(started(), email)).expect(302);
    await agent.post('/api/auth/sign-in/email').send({ email, password: WRONG_PASSWORD }).expect(401);
    const signedIn = await agent
      .post('/api/auth/sign-in/email')
      .send({ email, password: PASSWORD })
      .expect(200);
    const userId = (signedIn.body as { user: { id: string } }).user.id;
    await agent.post('/api/auth/sign-out').send({}).expect(200);

    const account = accountDigest(email);
    const address = { clientAddress: '198.51.100.70' };
    expect(events(log)).toEqual([
      { path: '/sign-up/email', outcome: 'ok', account, ...address },
      { path: '/verify-email', outcome: 'failed', code: 'INVALID_TOKEN', ...address },
      { path: '/verify-email', outcome: 'ok', ...address },
      { path: '/sign-in/email', outcome: 'failed', code: 'INVALID_EMAIL_OR_PASSWORD', account, ...address },
      { path: '/sign-in/email', outcome: 'ok', userId, ...address },
      { path: '/sign-out', outcome: 'ok', userId, ...address },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/ada@auth-events\.test|correct horse|wrong password/);
  });
});
