import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { browser, signUpVerified, type Browser } from './support/browser';
import { onPlan } from './support/plan';

// Guide step 1.6 end to end: onboarding, workspace routes, tenant isolation (404 for foreign
// tenants), invitations with workspace restriction, role changes that apply at once.

const workspace = {
  name: 'Brand Studio',
  timezone: 'Europe/Berlin',
  contentLanguage: 'de',
  industry: 'Software',
  targetAudience: '',
  goals: 'Mehr Reichweite',
  contentPillars: ['Produkt', 'Team'],
};

describe('tenancy API', () => {
  let api: ApiTestApp | undefined;
  let owner: Browser;
  let outsider: Browser;
  let organizationId = '';
  let slug = '';

  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };

  beforeAll(async () => {
    api = await startApiTestApp();
    owner = await signUpVerified(api, 'owner@acme.test', 'Olivia Owner');
    outsider = await signUpVerified(api, 'outsider@globex.test', 'Oscar Outsider');
  });

  afterAll(async () => {
    await api?.close();
  });

  it('creates the organization with its first workspace during onboarding', async () => {
    await owner.get('/api/me/memberships').expect(200, { memberships: [] });

    const created = await owner.post('/api/organizations').send({ name: 'Acme GmbH', workspace }).expect(201);
    organizationId = (created.body as { organizationId: string }).organizationId;
    slug = (created.body as { workspaceSlug: string }).workspaceSlug;
    expect(slug).toBe('brand-studio');

    const memberships = await owner.get('/api/me/memberships').expect(200);
    expect(memberships.body).toEqual({
      memberships: [
        {
          organizationId,
          organizationName: 'Acme GmbH',
          role: 'OWNER',
          workspaces: [{ id: expect.any(String) as string, slug, name: 'Brand Studio' }],
        },
      ],
    });

    const context = await owner.get(`/api/w/${slug}`).expect(200);
    expect(context.body).toMatchObject({
      workspace: { slug, name: 'Brand Studio', targetAudience: null, contentPillars: ['Produkt', 'Team'] },
      organization: { id: organizationId, name: 'Acme GmbH' },
      role: 'OWNER',
    });
    expect((context.body as { permissions: string[] }).permissions).toContain('billing.manage');
  });

  it('lets a user create three organizations in 30 days, also when the requests come at once', async () => {
    const founder = await signUpVerified(started(), 'founder@acme.test', 'Frida Founder');
    const create = (name: string) => founder.post('/api/organizations').send({ name, workspace });
    await create('Erste GmbH').expect(201);

    const parallel = await Promise.all(['Zweite GmbH', 'Dritte GmbH', 'Vierte GmbH'].map(create));

    expect(parallel.map((response) => response.status).sort()).toEqual([201, 201, 429]);
    expect(parallel.find((response) => response.status === 429)?.body).toMatchObject({
      code: 'ORGANIZATION_LIMIT_REACHED',
      params: { max: 3, days: 30 },
    });
    const memberships = await founder.get('/api/me/memberships').expect(200);
    expect((memberships.body as { memberships: unknown[] }).memberships).toHaveLength(3);
  });

  it('validates the onboarding input', async () => {
    const response = await owner
      .post('/api/organizations')
      .send({ name: 'A', workspace: { ...workspace, timezone: 'Mars/Olympus' } })
      .expect(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('answers 404 for tenants of others and for unknown ones', async () => {
    await outsider.get(`/api/w/${slug}`).expect(404);
    await outsider.get(`/api/w/${slug}/settings`).expect(404);
    await outsider.get(`/api/org/${organizationId}/members`).expect(404);
    const unknown = await owner.get('/api/w/does-not-exist').expect(404);
    expect(unknown.body).toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    await owner.get('/api/org/not-a-uuid/members').expect(404);
  });

  it('keeps the trial of a new organization to one workspace', async () => {
    const refused = await owner
      .post(`/api/org/${organizationId}/workspaces`)
      .send({ ...workspace, name: 'One Too Many' })
      .expect(402);
    expect(refused.body).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      params: { limit: 'maxWorkspaces', max: 1 },
    });
  });

  it('invites with a workspace restriction and turns the invitation into a membership', async () => {
    await onPlan(started(), organizationId);
    const second = await owner
      .post(`/api/org/${organizationId}/workspaces`)
      .send({ ...workspace, name: 'Hidden Corner' })
      .expect(201);
    const hiddenSlug = (second.body as { workspaceSlug: string }).workspaceSlug;
    const context = await owner.get(`/api/w/${slug}`).expect(200);
    const brandId = (context.body as { workspace: { id: string } }).workspace.id;

    await owner
      .post(`/api/org/${organizationId}/invitations`)
      .send({ email: 'Erin@Acme.test', role: 'EDITOR', workspaceIds: [brandId] })
      .expect(201);
    const message = started().invitations.at(-1);
    expect(message).toMatchObject({ email: 'erin@acme.test', role: 'EDITOR' });
    const token = message?.token ?? '';

    const listed = await owner.get(`/api/org/${organizationId}/invitations`).expect(200);
    expect(listed.body).toMatchObject({
      invitations: [{ email: 'erin@acme.test', role: 'EDITOR', invitedBy: 'Olivia Owner', expired: false }],
    });

    const preview = await browser(started().server)
      .post('/api/invitations/preview')
      .send({ token })
      .expect(200);
    expect(preview.body).toMatchObject({
      organizationName: 'Acme GmbH',
      invitedBy: 'Olivia Owner',
      email: 'erin@acme.test',
      role: 'EDITOR',
      status: 'open',
    });

    const erin = await signUpVerified(started(), 'erin@acme.test', 'Erin Editor');
    const accepted = await erin.post('/api/invitations/accept').send({ token }).expect(200);
    expect(accepted.body).toEqual({ organizationId, workspaceSlug: slug });

    await erin.get(`/api/w/${slug}`).expect(200);
    // The restriction hides the other workspace like a foreign one.
    await erin.get(`/api/w/${hiddenSlug}`).expect(404);
    const settings = await erin.patch(`/api/w/${slug}/settings`).send({ dryRun: true }).expect(403);
    expect(settings.body).toMatchObject({ code: 'NOT_PERMITTED' });

    // A used invitation shows as used and cannot be accepted again.
    const usedPreview = await browser(started().server)
      .post('/api/invitations/preview')
      .send({ token })
      .expect(200);
    expect(usedPreview.body).toMatchObject({ status: 'used' });
    const again = await erin.post('/api/invitations/accept').send({ token }).expect(409);
    expect(again.body).toMatchObject({ code: 'INVITATION_USED' });
  });

  it('applies a role change at once, despite the access cache', async () => {
    const members = await owner.get(`/api/org/${organizationId}/members`).expect(200);
    const erin = (members.body as { members: { id: string; email: string; role: string }[] }).members.find(
      (member) => member.email === 'erin@acme.test',
    );
    expect(erin?.role).toBe('EDITOR');

    const erinBrowser = await (async () => {
      const agent = browser(started().server);
      await agent
        .post('/api/auth/sign-in/email')
        .send({ email: 'erin@acme.test', password: 'correct horse battery staple' })
        .expect(200);
      return agent;
    })();
    await erinBrowser.get(`/api/w/${slug}`).expect(200);

    await owner
      .patch(`/api/org/${organizationId}/members/${erin?.id ?? ''}`)
      .send({ role: 'ADMIN' })
      .expect(204);
    const context = await erinBrowser.get(`/api/w/${slug}`).expect(200);
    expect(context.body).toMatchObject({ role: 'ADMIN' });
    await erinBrowser.patch(`/api/w/${slug}/settings`).send({ dryRun: true }).expect(200);

    await owner.delete(`/api/org/${organizationId}/members/${erin?.id ?? ''}`).expect(204);
    await erinBrowser.get(`/api/w/${slug}`).expect(404);
  });

  it('keeps the last owner and records every change in the audit log', async () => {
    const leave = await owner.post(`/api/org/${organizationId}/leave`).expect(409);
    expect(leave.body).toMatchObject({ code: 'LAST_OWNER' });

    const system = await started().database.connectAs('app_system');
    try {
      const { rows } = await system.query<{ action: string }>(
        'SELECT action FROM audit_log WHERE organization_id = $1 ORDER BY created_at, action',
        [organizationId],
      );
      expect(rows.map((row) => row.action)).toEqual([
        'organization.create',
        'workspace.create',
        'workspace.create',
        'member.invite',
        'member.join',
        'member.role_change',
        'workspace.settings_update',
        'member.remove',
      ]);
    } finally {
      await system.end();
    }
  });
});

describe('invitation email', () => {
  let api: ApiTestApp | undefined;

  beforeAll(async () => {
    api = await startApiTestApp({ captureInvitations: false });
  });

  afterAll(async () => {
    await api?.close();
  });

  it('reaches the invitee through the queue with a working link, in the inviter language', async () => {
    if (!api) {
      throw new Error('API is not running');
    }
    const owner = await signUpVerified(api, 'mail-owner@acme.test', 'Mia Owner');
    const created = await owner.post('/api/organizations').send({ name: 'Mail GmbH', workspace }).expect(201);
    const { organizationId } = created.body as { organizationId: string };
    await owner
      .post(`/api/org/${organizationId}/invitations`)
      .send({ email: 'newcomer@example.test', role: 'VIEWER' })
      .expect(201);

    const message = await api.mailpit.waitForMessage('newcomer@example.test');
    expect(message.Subject).toBe('Einladung zu Mail GmbH');
    expect(message.Text).toContain('Mia Owner hat Sie eingeladen');
    const link = /http:\/\/localhost:3000\/invite\/(\S+)/.exec(message.Text);
    expect(link).not.toBeNull();

    const preview = await browser(api.server)
      .post('/api/invitations/preview')
      .send({ token: decodeURIComponent(link?.[1] ?? '') })
      .expect(200);
    expect(preview.body).toMatchObject({ organizationName: 'Mail GmbH', status: 'open' });
  });
});
