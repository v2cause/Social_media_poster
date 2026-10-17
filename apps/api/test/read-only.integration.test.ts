import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { signUpVerified, type Browser } from './support/browser';

// Guide step 7.4: once the trial, the grace period of an overdue payment or the subscription has
// ended, the organization is read-only. Its changes answer 402 SUBSCRIPTION_INACTIVE; reading,
// paying and reducing what it uses still work.

describe('read-only organizations', () => {
  let api: ApiTestApp | undefined;
  let owner: Browser;
  let organizationId = '';
  let slug = '';

  const query = async (sql: string, values: unknown[] = []): Promise<void> => {
    if (!api) {
      throw new Error('API is not running');
    }
    const client = await api.database.connectAs('app_system');
    try {
      await client.query(sql, values);
    } finally {
      await client.end();
    }
  };
  const readOnlySince = (interval: string) =>
    query(`UPDATE subscription SET read_only_at = now() + $2::interval WHERE organization_id = $1`, [
      organizationId,
      interval,
    ]);

  beforeAll(async () => {
    api = await startApiTestApp();
    owner = await signUpVerified(api, 'read-only-owner@acme.test', 'Rita Owner');
    const created = await owner
      .post('/api/organizations')
      .send({
        name: 'Read Only GmbH',
        workspace: { name: 'Read Only', timezone: 'UTC', contentLanguage: 'de' },
      })
      .expect(201);
    ({ organizationId, workspaceSlug: slug } = created.body as {
      organizationId: string;
      workspaceSlug: string;
    });
  });

  afterAll(async () => {
    await api?.close();
  });

  it('refuses the changes of an organization whose trial ended, and keeps the reads', async () => {
    await readOnlySince('-1 minute');

    const refused = await owner
      .post(`/api/w/${slug}/posts`)
      .send({ language: 'de', brief: 'Neu', platforms: ['LINKEDIN'] })
      .expect(402);
    expect(refused.body).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
    await owner
      .post(`/api/org/${organizationId}/invitations`)
      .send({ email: 'new@acme.test', role: 'EDITOR', workspaceIds: [] })
      .expect(402);
    await owner.patch(`/api/w/${slug}/settings`).send({ dryRun: true }).expect(402);

    await owner.get(`/api/org/${organizationId}/members`).expect(200);
    await owner.get(`/api/w/${slug}/posts`).expect(200);
  });

  it('lets a read-only organization pay and reduce what it uses', async () => {
    await readOnlySince('-1 minute');

    // Past the guard: billing is not set up in this test app, and the invitation does not exist.
    const billing = await owner.post(`/api/org/${organizationId}/billing/checkout`).send({ plan: 'pro' });
    expect(billing.body).toMatchObject({ code: 'BILLING_UNAVAILABLE' });
    const revoke = await owner.delete(
      `/api/org/${organizationId}/invitations/0192f000-0000-7000-8000-000000000001`,
    );
    expect(revoke.status).toBe(404);
    // The data belong to the organization, paid or not (guide step 8.1).
    await owner.post(`/api/org/${organizationId}/data-exports`).expect(202);
  });

  it('writes again while the end of the trial lies ahead', async () => {
    await readOnlySince('1 day');

    await owner
      .post(`/api/w/${slug}/posts`)
      .send({ language: 'de', brief: 'Wieder da', platforms: ['LINKEDIN'] })
      .expect(201);
  });
});
