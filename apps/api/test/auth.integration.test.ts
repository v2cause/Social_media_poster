import { totpCode, totpCodes } from '@smp/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PASSWORD_FAILURES_PER_USER, SIGN_IN_FAILURES_PER_ACCOUNT } from '../src/modules/identity/auth-hooks';
import { APP_ORIGIN, startApiTestApp, type ApiTestApp } from './support/api-app';
import { browser as openBrowser, PASSWORD, signUpVerified } from './support/browser';
import { BREACHED_PASSWORD, UNCHECKABLE_PASSWORD } from './support/pwned-passwords';

// Spike 0.14(d) and guide steps 1.4 and 8.4: sign-up, email verification through Mailpit,
// sign-in, getSession in the AuthGuard, sign-out and two-factor authentication against the real
// API, with the hardening of step 8.4:
// - the link verifies the address without signing in,
// - failed sign-ins are limited per account and wrong passwords per user,
// - no device is trusted to skip the second factor, and every code of it works once,
// - a new sign-in ends the session the browser held, and a sign-out clears the site data,
// - a sign-up with a known address tells its owner,
// - a session ends seven days after the sign-in,
// - reset tokens are kept as digests only,
// - the password check of Better Auth is closed to browsers,
// - new passwords may be neither common, nor contain words of their context, nor be breached.

const WRONG_PASSWORD = 'wrong password 123';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The session cookie a response sets, as a Cookie header. */
const sessionCookieOf = (response: { headers: Record<string, unknown> }): string => {
  const cookies = response.headers['set-cookie'];
  const list = Array.isArray(cookies) ? (cookies as string[]) : typeof cookies === 'string' ? [cookies] : [];
  return list.find((cookie) => cookie.startsWith('smp.session_token='))?.split(';', 1)[0] ?? '';
};

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
    const code = totpCodes(body.totpURI);
    await agent.post('/api/auth/two-factor/verify-totp').send({ code: code() }).expect(200);
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

    await agent.post('/api/auth/two-factor/verify-totp').send({ code: code() }).expect(200);
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

  it('answers a sign-up with a known address like a new one and tells the owner of the address', async () => {
    await signUpVerified(started(), 'known@example.test');

    const fresh = await signUp(browser(), 'unknown@example.test');
    const known = await signUp(browser(), 'known@example.test');
    expect(known.status).toBe(200);
    expect(known.status).toBe(fresh.status);
    expect(Object.keys(known.body as object).sort()).toEqual(Object.keys(fresh.body as object).sort());

    const message = await started().mailpit.waitForMessage('known@example.test', {
      subject: 'Es gibt bereits ein Konto mit Ihrer E-Mail-Adresse',
    });
    expect(message.Text).toContain(`${APP_ORIGIN}/login`);
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

  it('asks for the second factor at every sign-in, even when the device should be trusted', async () => {
    const email = 'distrustful@example.test';
    const agent = await signUpVerified(started(), email);
    const enabled = await agent.post('/api/auth/two-factor/enable').send({ password: PASSWORD }).expect(200);
    const { totpURI } = enabled.body as { totpURI: string };
    const code = totpCodes(totpURI);
    await agent.post('/api/auth/two-factor/verify-totp').send({ code: code() }).expect(200);
    await agent.post('/api/auth/sign-out').send({}).expect(200);

    const first = await signIn(agent, email).expect(200);
    expect(first.body).toMatchObject({ twoFactorRedirect: true });
    const trusted = await agent
      .post('/api/auth/two-factor/verify-totp')
      .send({ code: code(), trustDevice: true })
      .expect(200);
    expect(cookiesOf(trusted)).not.toContain('trust_device');
    await agent.post('/api/auth/sign-out').send({}).expect(200);

    const second = await signIn(agent, email).expect(200);
    expect(second.body).toMatchObject({ twoFactorRedirect: true });
    await agent.get('/api/me').expect(401);
  });

  it('takes every code of the second factor once, also across two sign-ins', async () => {
    const email = 'once@example.test';
    const agent = await signUpVerified(started(), email);
    const enabled = await agent.post('/api/auth/two-factor/enable').send({ password: PASSWORD }).expect(200);
    const { totpURI } = enabled.body as { totpURI: string };
    const used = totpCode(totpURI);
    await agent.post('/api/auth/two-factor/verify-totp').send({ code: used }).expect(200);

    // Whoever saw the code and knows the password signs in elsewhere within its 90 seconds.
    const other = browser();
    await signIn(other, email).expect(200);
    const replayed = await other.post('/api/auth/two-factor/verify-totp').send({ code: used });
    expect(replayed.status).toBe(401);
    expect(replayed.body).toMatchObject({ code: 'CODE_ALREADY_USED' });
    await other.get('/api/me').expect(401);

    // The next code still opens the sign-in.
    const next = totpCode(totpURI, Date.now() + 30_000);
    await other.post('/api/auth/two-factor/verify-totp').send({ code: next }).expect(200);
    await other.get('/api/me').expect(200);
  });

  it('ends the session the browser held when it signs in again, and clears the site at sign-out', async () => {
    const email = 'again@example.test';
    const agent = await signUpVerified(started(), email);
    const server = started().server;
    const fromBrowser = (address: string) =>
      request(server).post('/api/auth/sign-in/email').set('Origin', APP_ORIGIN).set('X-Real-IP', address);

    const first = await fromBrowser('192.0.2.240').send({ email, password: PASSWORD }).expect(200);
    const old = sessionCookieOf(first);
    const second = await fromBrowser('192.0.2.240')
      .set('Cookie', old)
      .send({ email, password: PASSWORD })
      .expect(200);
    const fresh = sessionCookieOf(second);

    expect(fresh).not.toBe(old);
    await request(server).get('/api/me').set('Cookie', old).expect(401);
    await request(server).get('/api/me').set('Cookie', fresh).expect(200);

    const out = await agent.post('/api/auth/sign-out').send({}).expect(200);
    expect(out.headers['clear-site-data']).toBe('"cache", "storage"');
  });

  it('ends a session seven days after the sign-in, however often it is used', async () => {
    const email = 'busy@example.test';
    const agent = await signUpVerified(started(), email);
    const system = await started().database.connectAs('app_system');
    try {
      // Five days left: Better Auth would push the end out again on the next use.
      const fiveDays = new Date(Date.now() + 5 * DAY_MS);
      await system.query(
        `UPDATE session SET expires_at = $2 WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
        [email, fiveDays],
      );
      await agent.get('/api/auth/get-session').expect(200);
      await agent.get('/api/me').expect(200);

      const { rows } = await system.query<{ expires_at: Date }>(
        `SELECT expires_at FROM session WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
        [email],
      );
      expect(rows.map((row) => row.expires_at.getTime())).toEqual([fiveDays.getTime()]);
    } finally {
      await system.end();
    }
  });

  it('keeps only a digest of a reset token in the database', async () => {
    const email = 'forgetful@example.test';
    await signUpVerified(started(), email);
    await browser()
      .post('/api/auth/request-password-reset')
      .send({ email, redirectTo: '/reset-password' })
      .expect(200);
    const message = await started().mailpit.waitForMessage(email, { subject: 'Passwort zurücksetzen' });
    const token = /reset-password\/([\w-]+)/.exec(message.Text)?.[1] ?? '';
    expect(token.length).toBeGreaterThan(10);

    const system = await started().database.connectAs('app_system');
    try {
      const { rows } = await system.query<{ identifier: string }>(
        `SELECT identifier FROM verification WHERE value = (SELECT id::text FROM users WHERE email = $1)`,
        [email],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.identifier).not.toContain(token);
    } finally {
      await system.end();
    }
  });

  it('does not offer the password check of Better Auth to browsers', async () => {
    const agent = await signUpVerified(started(), 'password-check@example.test');
    await agent.post('/api/auth/verify-password').send({ password: PASSWORD }).expect(404);
  });

  it('refuses a common password at sign-up, for a new address as for a known one', async () => {
    const fresh = await signUp(browser(), 'common@example.test', { password: '1qaz2wsx3edc' });
    const known = await signUp(browser(), 'ada@example.test', { password: '1QAZ2WSX3EDC' });
    for (const response of [fresh, known]) {
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'PASSWORD_TOO_COMMON' });
    }
  });

  it('refuses a password with the name or the address of the user', async () => {
    const response = await signUp(browser(), 'charles.babbage@example.test', {
      name: 'Charles Babbage',
      password: 'the BABBAGE engine of 1822',
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'PASSWORD_CONTAINS_CONTEXT' });
  });

  it('refuses a breached password, and lets one pass when the breach check is down', async () => {
    const asked = started().pwnedPasswords.prefixes.length;
    const breached = await signUp(browser(), 'reused@example.test', { password: BREACHED_PASSWORD });
    expect(breached.status).toBe(400);
    expect(breached.body).toMatchObject({ code: 'PASSWORD_COMPROMISED' });

    await signUp(browser(), 'unlucky@example.test', { password: UNCHECKABLE_PASSWORD }).expect(200);
    // Only the first five characters of the hashes went out.
    const prefixes = started().pwnedPasswords.prefixes.slice(asked);
    expect(prefixes).toHaveLength(2);
    expect(prefixes.every((prefix) => /^[0-9A-F]{5}$/.test(prefix))).toBe(true);
  });

  it('applies the password policy to the change and the reset of a password', async () => {
    const email = 'mary@example.test';
    const agent = await signUpVerified(started(), email, 'Mary Somerville');
    const changed = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: 'somerville wrote on physics' });
    expect(changed.status).toBe(400);
    expect(changed.body).toMatchObject({ code: 'PASSWORD_CONTAINS_CONTEXT' });

    await browser()
      .post('/api/auth/request-password-reset')
      .send({ email, redirectTo: '/reset-password' })
      .expect(200);
    const message = await started().mailpit.waitForMessage(email, { subject: 'Passwort zurücksetzen' });
    const token = /reset-password\/([\w-]+)/.exec(message.Text)?.[1] ?? '';
    const reset = (newPassword: string) =>
      browser().post('/api/auth/reset-password').send({ token, newPassword });
    // The reset knows its user by the token only, and still checks the name.
    await reset('mary somerville again').expect(400, /PASSWORD_CONTAINS_CONTEXT/);
    await reset(BREACHED_PASSWORD).expect(400, /PASSWORD_COMPROMISED/);
    await reset('a quiet river under the old bridge').expect(200);
    await signIn(browser(), email, 'a quiet river under the old bridge').expect(200);
  });
});
