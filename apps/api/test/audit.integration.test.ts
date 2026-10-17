import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { signUpVerified, type Browser } from './support/browser';
import { onPlan } from './support/plan';

// Guide step 1.7: every tenancy action leaves an entry with actor, address and user agent, and
// the log pages with a cursor and filters by action, actor and period.

interface Page {
  entries: {
    action: string;
    actor: { name: string } | null;
    ipAddress: string | null;
    userAgent: string | null;
  }[];
  nextCursor: string | null;
}

describe('audit log API', () => {
  let api: ApiTestApp | undefined;
  let owner: Browser;
  let organizationId = '';

  beforeAll(async () => {
    api = await startApiTestApp();
    owner = await signUpVerified(api, 'audit-owner@acme.test', 'Audrey Owner');
    owner.set('User-Agent', 'audit-test-agent');
    const created = await owner
      .post('/api/organizations')
      .send({
        name: 'Audit GmbH',
        workspace: { name: 'Audit Space', timezone: 'UTC', contentLanguage: 'en' },
      })
      .expect(201);
    organizationId = (created.body as { organizationId: string }).organizationId;
    await onPlan(api, organizationId);
    for (const email of ['a@example.test', 'b@example.test', 'c@example.test']) {
      await owner.post(`/api/org/${organizationId}/invitations`).send({ email, role: 'VIEWER' }).expect(201);
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  it('lists the newest entries first with actor, address and user agent', async () => {
    const response = await owner.get(`/api/org/${organizationId}/audit-log`).expect(200);
    const page = response.body as Page;
    expect(page.entries.map((entry) => entry.action)).toEqual([
      'member.invite',
      'member.invite',
      'member.invite',
      'workspace.create',
      'organization.create',
    ]);
    expect(page.entries[0]).toMatchObject({
      actor: { name: 'Audrey Owner' },
      ipAddress: expect.any(String) as string,
      userAgent: 'audit-test-agent',
    });
    expect(JSON.stringify(page)).not.toMatch(/token/i);
    expect(page.nextCursor).toBeNull();
  });

  it('pages with a cursor without gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const response = await owner.get(`/api/org/${organizationId}/audit-log?limit=2${query}`).expect(200);
      const page = response.body as Page & { entries: { id?: string }[] };
      seen.push(...page.entries.map((entry) => entry.action));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
  });

  it('filters by action and period', async () => {
    const invites = await owner.get(`/api/org/${organizationId}/audit-log?action=member.invite`).expect(200);
    expect((invites.body as Page).entries).toHaveLength(3);

    const future = new Date(Date.now() + 60_000).toISOString();
    const none = await owner.get(`/api/org/${organizationId}/audit-log?from=${future}`).expect(200);
    expect((none.body as Page).entries).toEqual([]);
  });

  it('rejects a forged cursor', async () => {
    const response = await owner
      .get(`/api/org/${organizationId}/audit-log?cursor=bm90LWEtY3Vyc29y`)
      .expect(422);
    expect(response.body).toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
