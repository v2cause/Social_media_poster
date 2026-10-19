import { createPrismaClient, type PrismaClient } from '@smp/db';
import { NotificationProducer } from '@smp/queue';
import { totpCodes } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openMembershipLookup, type MembershipLookup } from '../src/infrastructure/user-memberships';
import { checkTwoFactorReset, resetTwoFactor } from '../src/modules/identity/reset-two-factor';
import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { browser, PASSWORD, signUpVerified } from './support/browser';

// Guide step 8.7 (ASVS 6.4.4): an operator removes a lost second factor only after the person
// reset the password through the link to the address, as at the sign-up. The check before names
// the organizations of the person by ID, for the confirmation of their owners. The factor and its
// backup codes go, every session ends, the address gets an email, and the next sign-in asks for
// the password alone.

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_PASSWORD = 'quiet harbour seven lanterns';
const workspace = { name: 'Lost Phone Studio', timezone: 'Europe/Berlin', contentLanguage: 'de' };

describe('removing a lost second factor', () => {
  let api: ApiTestApp | undefined;
  let prisma: PrismaClient | undefined;
  let lookup: MembershipLookup | undefined;

  const started = (): { api: ApiTestApp; prisma: PrismaClient; lookup: MembershipLookup } => {
    if (!api || !prisma || !lookup) {
      throw new Error('API is not running');
    }
    return { api, prisma, lookup };
  };
  const dependencies = () => ({
    prisma: started().prisma,
    memberships: started().lookup.memberships,
    notifications: started().api.app.get(NotificationProducer),
    appUrl: started().api.env.APP_URL,
  });
  const reset = (email: string) => resetTwoFactor(dependencies(), email, new Date());
  const check = (email: string) => checkTwoFactorReset(dependencies(), email, new Date());

  beforeAll(async () => {
    api = await startApiTestApp();
    prisma = createPrismaClient(api.database.url('app_user'));
    lookup = openMembershipLookup(api.database.url('app_system'));
  });

  afterAll(async () => {
    await lookup?.close();
    await prisma?.$disconnect();
    await api?.close();
  });

  it('removes the factor only after a password reset, ends the sessions and tells the address', async () => {
    const email = 'lost-phone@example.test';
    const agent = await signUpVerified(started().api, email, 'Ada Lovelace');
    const created = await agent
      .post('/api/organizations')
      .send({ name: 'Lovelace GmbH', workspace })
      .expect(201);
    const organizationId = (created.body as { organizationId: string }).organizationId;
    const enabled = await agent.post('/api/auth/two-factor/enable').send({ password: PASSWORD }).expect(200);
    const code = totpCodes((enabled.body as { totpURI: string }).totpURI);
    await agent.post('/api/auth/two-factor/verify-totp').send({ code: code() }).expect(200);
    const user = await started().prisma.user.findUniqueOrThrow({ where: { email } });
    const memberships = [{ organizationId, role: 'OWNER', otherOwners: 0, requireTwoFactor: false }];

    // Long after the sign-up, without a reset: the check says so, and the reset refuses.
    const signedUpLongAgo = new Date(Date.now() - 30 * DAY_MS);
    await started().prisma.account.updateMany({
      where: { userId: user.id },
      data: { createdAt: signedUpLongAgo, updatedAt: signedUpLongAgo },
    });
    await expect(check(email)).resolves.toEqual({
      status: 'found',
      userId: user.id,
      twoFactorEnabled: true,
      platformAdmin: false,
      resetAt: null,
      memberships,
    });
    await expect(reset(email)).resolves.toEqual({ status: 'no_recent_password_reset' });
    await expect(reset('nobody@example.test')).resolves.toEqual({ status: 'not_found' });
    await expect(check('nobody@example.test')).resolves.toEqual({ status: 'not_found' });

    // The person resets the password through the link to the address.
    await browser(started().api.server)
      .post('/api/auth/request-password-reset')
      .send({ email, redirectTo: '/reset-password' })
      .expect(200);
    const message = await started().api.mailpit.waitForMessage(email, { subject: 'Passwort zurücksetzen' });
    const token = /reset-password\/([\w-]+)/.exec(message.Text)?.[1] ?? '';
    await browser(started().api.server)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);
    await expect(check(email)).resolves.toMatchObject({ resetAt: expect.any(Date) as Date });

    // A session that still passed the second factor before the operator acts.
    const before = browser(started().api.server);
    const first = await before
      .post('/api/auth/sign-in/email')
      .send({ email, password: NEW_PASSWORD })
      .expect(200);
    expect(first.body).toMatchObject({ twoFactorRedirect: true });
    await before.post('/api/auth/two-factor/verify-totp').send({ code: code() }).expect(200);
    await before.get('/api/me').expect(200);

    await expect(reset(email)).resolves.toEqual({
      status: 'reset',
      userId: user.id,
      resetAt: expect.any(Date) as Date,
      hadSecondFactor: true,
      sessions: 1,
      memberships,
    });
    await before.get('/api/me').expect(401);
    await expect(started().prisma.twoFactor.count({ where: { userId: user.id } })).resolves.toBe(0);

    // The next sign-in needs the password alone.
    const after = browser(started().api.server);
    const signedIn = await after
      .post('/api/auth/sign-in/email')
      .send({ email, password: NEW_PASSWORD })
      .expect(200);
    expect(signedIn.body).not.toHaveProperty('twoFactorRedirect');
    await after.get('/api/me').expect(200);

    const notice = await started().api.mailpit.waitForMessage(email, {
      subject: 'Der zweite Faktor Ihres Kontos wurde entfernt',
    });
    expect(notice.Text).toContain(`${started().api.env.APP_URL.replace(/\/$/, '')}/account/security`);
    expect(notice.Text).toContain('Hallo Ada Lovelace,');
  });

  it('does not count a reset older than a day', async () => {
    const email = 'old-reset@example.test';
    await signUpVerified(started().api, email);
    const user = await started().prisma.user.findUniqueOrThrow({ where: { email } });
    await started().prisma.account.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - 30 * DAY_MS), updatedAt: new Date(Date.now() - 2 * DAY_MS) },
    });

    await expect(reset(email)).resolves.toEqual({ status: 'no_recent_password_reset' });
  });
});
