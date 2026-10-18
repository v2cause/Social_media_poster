import { totpCode } from '@smp/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PASSWORD_FAILURES_PER_USER, SIGN_IN_FAILURES_PER_ACCOUNT } from '../src/modules/identity/auth-hooks';
import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { browser as openBrowser, PASSWORD, signUpVerified } from './support/browser';

// Spike 0.14(d) and guide steps 1.4 and 8.4: sign-up, email verification through Mailpit,
// sign-in, getSession in the AuthGuard, sign-out and two-factor authentication against the real
// API, with the hardening of step 8.4:
// - the link verifies the address without signing in,
// - failed sign-ins are limited per account and wrong passwords per user.

const WRONG_PASSWORD = 'wrong password 123';

/** The cookies a response sets: supertest types the header as a string, Node hands an array. */
const cookiesOf = (response: { headers: Record<string, unknown> }): string => {
  const cookies = response.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies.join('; ') : typeof cookies === 'string' ? cookies : '';
};

describe('authentication with Better Auth', () => {
  let api: ApiTestApp | undefined;

  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };
  const browser = (address?: string) => openBrowser(started().server, address);

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
  const signIn = (agent: ReturnType<typeof browser>, email: string, password = PASSWORD) =>
    agent.post('/api/auth/sign-in/email').send({ email, password });

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

  it('signs up, verifies the address from the email and signs in with the password', async () => {
    const agent = browser();
    await signUp(agent, 'ada@example.test').expect(200);

    const { message, response } = await verify(agent, 'ada@example.test');
    expect(message.Subject).toBe('Bestätigen Sie Ihre E-Mail-Adresse');
    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('/onboarding');
    // The link verifies the address but opens no session: whoever signed up with an address
    // first must not hold the account its owner verifies.
    expect(cookiesOf(response)).not.toContain('session_token');
    await agent.get('/api/me').expect(401);

    await signIn(agent, 'ada@example.test').expect(200);
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
    await signIn(agent, 'linus@example.test').expect(200);
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
    await signIn(agent, 'margaret@example.test').expect(200);

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
    const again = await signIn(agent, 'margaret@example.test').expect(200);
    expect(again.body).toMatchObject({ twoFactorRedirect: true });
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
    const message = await started().mailpit.waitForMessage('ada@example.test', {
      subject: 'Passwort zurücksetzen',
    });
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
        .send({ email: 'ada@example.test', password: WRONG_PASSWORD });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });

  it('blocks the sign-in to an account after ten failures, from whatever addresses they come', async () => {
    const email = 'besieged@example.test';
    await signUpVerified(started(), email);

    // A new client address for each attempt, so that the limit per address never applies.
    for (let attempt = 0; attempt < SIGN_IN_FAILURES_PER_ACCOUNT; attempt += 1) {
      await signIn(browser(), email, WRONG_PASSWORD).expect(401);
    }
    const blocked = await signIn(browser(), email);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });

  it('blocks the password checks of a signed-in user after five wrong passwords', async () => {
    const agent = await signUpVerified(started(), 'stolen-session@example.test');

    // Better Auth allows three requests per path and ten seconds, so the guesses go to two paths.
    for (let attempt = 0; attempt < PASSWORD_FAILURES_PER_USER; attempt += 1) {
      const response =
        attempt < 3
          ? await agent
              .post('/api/auth/change-password')
              .send({ currentPassword: WRONG_PASSWORD, newPassword: 'a brand new password 456' })
          : await agent.post('/api/auth/two-factor/enable').send({ password: WRONG_PASSWORD });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'INVALID_PASSWORD' });
    }
    // Even the right password is refused now, so the second factor cannot be taken over.
    const blocked = await agent.post('/api/auth/two-factor/enable').send({ password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });
});
