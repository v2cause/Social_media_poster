import { totpCode } from '@smp/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_ORIGIN, startApiTestApp, type ApiTestApp } from './support/api-app';

// Spike 0.14(d) and guide step 1.4: sign-up, email verification through Mailpit, sign-in,
// getSession in the AuthGuard, sign-out and two-factor authentication against the real API.

const PASSWORD = 'correct horse battery staple';

describe('authentication with Better Auth', () => {
  let api: ApiTestApp | undefined;

  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };
  /**
   * A cookie-keeping client that behaves like the browser on the app origin. Each one gets its own
   * client address (X-Real-IP, set by the reverse proxy in production), so the rate limits of one
   * test do not spill into the next.
   */
  let nextAddress = 10;
  const browser = (address = `192.0.2.${String((nextAddress += 1))}`) =>
    request.agent(started().server).set('Origin', APP_ORIGIN).set('X-Real-IP', address);

  const signUp = (agent: ReturnType<typeof browser>, email: string, extra: object = {}) =>
    agent
      .post('/api/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Ada Lovelace', callbackURL: '/onboarding', ...extra });

  /** Opens the verification link from the email, as the user would. */
  const verify = async (agent: ReturnType<typeof browser>, email: string) => {
    const message = await started().mailpit.waitForMessage(email);
    const link = /https?:\/\/\S+verify-email\S+/.exec(message.Text)?.[0];
    if (!link) {
      throw new Error('no verification link in the email');
    }
    const url = new URL(link);
    return { message, response: await agent.get(`${url.pathname}${url.search}`) };
  };

  beforeAll(async () => {
    api = await startApiTestApp();
  });

  afterAll(async () => {
    await api?.close();
  });

  it('rejects API routes without a session', async () => {
    const response = await request(started().server).get('/api/me');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'HTTP_401' });
  });

  it('keeps the health routes public', async () => {
    await request(started().server).get('/api/health/live').expect(200);
  });

  it('signs up, verifies the address from the email and opens a session', async () => {
    const agent = browser();
    await signUp(agent, 'ada@example.test').expect(200);

    const { message, response } = await verify(agent, 'ada@example.test');
    expect(message.Subject).toBe('Bestätigen Sie Ihre E-Mail-Adresse');
    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('/onboarding');

    const me = await agent.get('/api/me').expect(200);
    expect(me.body).toMatchObject({
      email: 'ada@example.test',
      name: 'Ada Lovelace',
      emailVerified: true,
      twoFactorEnabled: false,
      locale: 'de',
      timezone: 'Europe/Berlin',
    });
    expect(me.body).not.toHaveProperty('isPlatformAdmin');
  });

  it('sends the verification email in the language chosen at sign-up', async () => {
    await signUp(browser(), 'grace@example.test', { locale: 'en' }).expect(200);
    const message = await started().mailpit.waitForMessage('grace@example.test');
    expect(message.Subject).toBe('Confirm your email address');
  });

  it('refuses to sign in before the address is verified', async () => {
    const agent = browser();
    await signUp(agent, 'unverified@example.test').expect(200);
    const response = await agent
      .post('/api/auth/sign-in/email')
      .send({ email: 'unverified@example.test', password: PASSWORD });
    expect(response.status).toBe(403);
    await agent.get('/api/me').expect(401);
  });

  it('ignores isPlatformAdmin at sign-up', async () => {
    const response = await signUp(browser(), 'mallory@example.test', { isPlatformAdmin: true });
    expect(response.status).toBeLessThan(500);
    const system = await started().database.connectAs('app_system');
    try {
      const { rows } = await system.query<{ is_platform_admin: boolean }>(
        'SELECT is_platform_admin FROM users WHERE email = $1',
        ['mallory@example.test'],
      );
      expect(rows.every((row) => !row.is_platform_admin)).toBe(true);
    } finally {
      await system.end();
    }
  });

  it('signs out and in again', async () => {
    const agent = browser();
    await signUp(agent, 'linus@example.test').expect(200);
    await verify(agent, 'linus@example.test');
    await agent.get('/api/me').expect(200);

    await agent.post('/api/auth/sign-out').send({}).expect(200);
    await agent.get('/api/me').expect(401);

    await agent
      .post('/api/auth/sign-in/email')
      .send({ email: 'linus@example.test', password: PASSWORD })
      .expect(200);
    await agent.get('/api/me').expect(200);
  });

  it('enables two-factor authentication and asks for the code at the next sign-in', async () => {
    const agent = browser();
    await signUp(agent, 'margaret@example.test').expect(200);
    await verify(agent, 'margaret@example.test');

    const enabled = await agent.post('/api/auth/two-factor/enable').send({ password: PASSWORD }).expect(200);
    const body = enabled.body as { totpURI: string; backupCodes: string[] };
    expect(body.backupCodes.length).toBeGreaterThan(0);
    await agent
      .post('/api/auth/two-factor/verify-totp')
      .send({ code: totpCode(body.totpURI) })
      .expect(200);
    await agent
      .get('/api/me')
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ twoFactorEnabled: true });
      });

    await agent.post('/api/auth/sign-out').send({}).expect(200);
    const signIn = await agent
      .post('/api/auth/sign-in/email')
      .send({ email: 'margaret@example.test', password: PASSWORD })
      .expect(200);
    expect(signIn.body).toMatchObject({ twoFactorRedirect: true });
    await agent.get('/api/me').expect(401);

    await agent
      .post('/api/auth/two-factor/verify-totp')
      .send({ code: totpCode(body.totpURI) })
      .expect(200);
    await agent.get('/api/me').expect(200);
  });

  it('answers a password reset request the same way for unknown addresses', async () => {
    const known = await browser()
      .post('/api/auth/request-password-reset')
      .send({ email: 'ada@example.test', redirectTo: '/reset-password' });
    const unknown = await browser()
      .post('/api/auth/request-password-reset')
      .send({ email: 'nobody@example.test', redirectTo: '/reset-password' });

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    const message = await started().mailpit.waitForMessage('ada@example.test');
    expect(message.Subject).toBe('Passwort zurücksetzen');
  });

  it('rejects auth requests from a foreign origin', async () => {
    const response = await request(started().server)
      .post('/api/auth/sign-in/email')
      .set('Origin', 'https://evil.example')
      .send({ email: 'ada@example.test', password: PASSWORD });
    expect(response.status).toBe(403);
  });

  it('rate limits repeated sign-in attempts', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await browser('198.51.100.7')
        .post('/api/auth/sign-in/email')
        .send({ email: 'ada@example.test', password: 'wrong password 123' });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });
});
