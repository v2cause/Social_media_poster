import { totpCodes } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { PASSWORD, signUpVerified, type Browser } from './support/browser';
import { onPlan } from './support/plan';

// Architecture 10 and guide step 8.4: owners require a second factor of every member. Members
// without one reach no route of the organization, its workspaces included, until they set one
// up; the routes of the account stay open, so that they can.

const workspace = {
  name: 'Vault',
  timezone: 'Europe/Berlin',
  contentLanguage: 'de',
  industry: '',
  targetAudience: '',
  goals: '',
  contentPillars: [],
};

describe('the second factor an organization requires', () => {
  let api: ApiTestApp | undefined;
  let owner: Browser;
  let organizationId = '';
  let slug = '';

  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };

  /** Turns the second factor on for the signed-in user. */
  const enableTwoFactor = async (agent: Browser): Promise<void> => {
    const enabled = await agent.post('/api/auth/two-factor/enable').send({ password: PASSWORD }).expect(200);
    const code = totpCodes((enabled.body as { totpURI: string }).totpURI);
    await agent.post('/api/auth/two-factor/verify-totp').send({ code: code() }).expect(200);
  };

  /** Invites the address as admin and lets it accept with a fresh account. */
  const admitAdmin = async (email: string): Promise<Browser> => {
    await owner.post(`/api/org/${organizationId}/invitations`).send({ email, role: 'ADMIN' }).expect(201);
    const token = started().invitations.at(-1)?.token ?? '';
    const member = await signUpVerified(started(), email, 'Ada Admin');
    await member.post('/api/invitations/accept').send({ token }).expect(200);
    return member;
  };

  beforeAll(async () => {
    api = await startApiTestApp();
    owner = await signUpVerified(api, 'owner@strict.test', 'Olivia Owner');
    const created = await owner
      .post('/api/organizations')
      .send({ name: 'Strict GmbH', workspace })
      .expect(201);
    ({ organizationId, workspaceSlug: slug } = created.body as {
      organizationId: string;
      workspaceSlug: string;
    });
    await onPlan(api, organizationId);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('asks the owner for a second factor of their own first', async () => {
    const refused = await owner
      .put(`/api/org/${organizationId}/security`)
      .send({ requireTwoFactor: true })
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'TWO_FACTOR_SETUP_REQUIRED' });

    const context = await owner.get(`/api/org/${organizationId}`).expect(200);
    expect(context.body).toMatchObject({ security: { requireTwoFactor: false } });
  });

  it('keeps members without a second factor out of the organization until they set one up', async () => {
    const admin = await admitAdmin('admin@strict.test');
    await admin.get(`/api/w/${slug}`).expect(200);
    await enableTwoFactor(owner);

    await owner
      .put(`/api/org/${organizationId}/security`)
      .send({ requireTwoFactor: true })
      .expect(200, { requireTwoFactor: true });
    const context = await owner.get(`/api/org/${organizationId}`).expect(200);
    expect(context.body).toMatchObject({ security: { requireTwoFactor: true } });

    // The cached access of the admin went with the change, so the next request is refused.
    for (const path of [
      `/api/org/${organizationId}`,
      `/api/w/${slug}`,
      `/api/org/${organizationId}/members`,
    ]) {
      const refused = await admin.get(path).expect(403);
      expect(refused.body).toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    }
    await admin.get('/api/me').expect(200);

    await enableTwoFactor(admin);
    await admin.get(`/api/w/${slug}`).expect(200);
    await admin.get(`/api/org/${organizationId}`).expect(200);
  });

  it('leaves the requirement to owners and records every change', async () => {
    const admin = await admitAdmin('second-admin@strict.test');
    await enableTwoFactor(admin);

    const refused = await admin
      .put(`/api/org/${organizationId}/security`)
      .send({ requireTwoFactor: false })
      .expect(403);
    expect(refused.body).toMatchObject({ code: 'NOT_PERMITTED' });

    await owner
      .put(`/api/org/${organizationId}/security`)
      .send({ requireTwoFactor: false })
      .expect(200, { requireTwoFactor: false });
    const log = await owner.get(`/api/org/${organizationId}/audit-log`).expect(200);
    const actions = (log.body as { entries: { action: string }[] }).entries.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(['organization.two_factor_required', 'organization.two_factor_optional']),
    );
  });
});
