import { createStripeClient, syncCatalog } from '@smp/billing';
import { FakeStripe } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_ORIGIN, startApiTestApp, type ApiTestApp } from './support/api-app';
import { signUpVerified, type Browser } from './support/browser';

// Guide step 8.2 through the API: an owner deletes the organization by typing its name. From then
// on its routes answer 409 ORGANIZATION_DELETION_PENDING to every member at once, despite the
// access cache, apart from the contexts, which show the deletion, the data exports and taking the
// deletion back. The paid subscription ends with its period, and every owner hears by email on
// which day the organization is erased. Taking the deletion back undoes all of it.

const WEBHOOK_SECRET = 'whsec_test_deletion_api';
const DAY_MS = 24 * 60 * 60 * 1000;
const NAME = 'Abschied GmbH';

describe('organization deletion API', () => {
  let api: ApiTestApp | undefined;
  let fake: FakeStripe | undefined;
  let owner: Browser;
  let editor: Browser;
  let organizationId = '';
  let workspaceId = '';
  let slug = '';
  let subscriptionId = '';

  const started = () => {
    if (!api || !fake) {
      throw new Error('not started');
    }
    return { api, fake };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().api.database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const cancelsAtPeriodEnd = (): unknown =>
    started().fake.subscriptions.get(subscriptionId)?.['cancel_at_period_end'];
  const auditActions = async (): Promise<string[]> =>
    (
      await query<{ action: string }>(
        `SELECT action FROM audit_log WHERE organization_id = $1 AND action LIKE 'organization.delete%'
          ORDER BY created_at`,
        [organizationId],
      )
    ).map((row) => row.action);

  beforeAll(async () => {
    fake = await FakeStripe.start({ webhookSecret: WEBHOOK_SECRET });
    api = await startApiTestApp({
      env: {
        STRIPE_SECRET_KEY: 'sk_test_deletion',
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STRIPE_API_BASE: fake.url,
      },
    });
    await syncCatalog(createStripeClient({ secretKey: 'sk_test_sync', apiBase: fake.url }));

    owner = await signUpVerified(api, 'deletion-owner@abschied.test', 'Doris Owner');
    const created = await owner
      .post('/api/organizations')
      .send({ name: NAME, workspace: { name: 'Abschied', timezone: 'UTC', contentLanguage: 'de' } })
      .expect(201);
    ({ organizationId, workspaceSlug: slug } = created.body as {
      organizationId: string;
      workspaceSlug: string;
    });
    const context = await owner.get(`/api/w/${slug}`).expect(200);
    workspaceId = (context.body as { workspace: { id: string } }).workspace.id;

    await owner
      .post(`/api/org/${organizationId}/invitations`)
      .send({ email: 'deletion-editor@abschied.test', role: 'EDITOR', workspaceIds: [workspaceId] })
      .expect(201);
    const token = api.invitations.at(-1)?.token ?? '';
    editor = await signUpVerified(api, 'deletion-editor@abschied.test', 'Emil Editor');
    await editor.post('/api/invitations/accept').send({ token }).expect(200);

    // A paid subscription that renews: bought in the checkout, synced as the role "billing" does.
    await owner.post(`/api/org/${organizationId}/billing/checkout`).send({ plan: 'pro' }).expect(201);
    const checkout = [...fake.checkouts.values()].at(-1);
    const subscription = await fake.completeCheckout(String(checkout?.['id']));
    subscriptionId = String(subscription['id']);
    await query(
      `UPDATE subscription
          SET plan_key = 'pro', status = 'ACTIVE', stripe_subscription_id = $2, cancel_at_period_end = false,
              current_period_start = now(), current_period_end = now() + interval '30 days'
        WHERE organization_id = $1`,
      [organizationId, subscriptionId],
    );
  });

  afterAll(async () => {
    await api?.close();
    await fake?.close();
  });

  it('refuses the deletion with another name and to members who are not owners', async () => {
    const wrong = await owner
      .post(`/api/org/${organizationId}/deletion`)
      .send({ confirmName: 'Abschied AG' })
      .expect(422);
    expect(wrong.body).toMatchObject({ code: 'ORGANIZATION_NAME_MISMATCH' });
    const notOwner = await editor
      .post(`/api/org/${organizationId}/deletion`)
      .send({ confirmName: NAME })
      .expect(403);
    expect(notOwner.body).toMatchObject({ code: 'NOT_PERMITTED' });

    const context = await owner.get(`/api/org/${organizationId}`).expect(200);
    expect(context.body).toMatchObject({ deletion: null });
    expect(cancelsAtPeriodEnd()).toBe(false);
    await expect(auditActions()).resolves.toEqual([]);
  });

  it('stops every member at once and keeps the contexts, the data exports and the way back', async () => {
    // The editor works first, so the access of the editor is cached.
    await editor.get(`/api/w/${slug}/posts`).expect(200);

    const deleted = await owner
      .post(`/api/org/${organizationId}/deletion`)
      .send({ confirmName: ` ${NAME} ` })
      .expect(201);
    const deletion = deleted.body as { deletedAt: string; eraseAfter: string };
    expect(Date.parse(deletion.eraseAfter) - Date.parse(deletion.deletedAt)).toBe(30 * DAY_MS);

    const blocked = await editor.get(`/api/w/${slug}/posts`).expect(409);
    expect(blocked.body).toMatchObject({ code: 'ORGANIZATION_DELETION_PENDING' });
    await owner.get(`/api/org/${organizationId}/members`).expect(409);
    for (const member of [owner, editor]) {
      const context = await member.get(`/api/w/${slug}`).expect(200);
      expect(context.body).toMatchObject({ deletion });
    }
    const organization = await owner.get(`/api/org/${organizationId}`).expect(200);
    expect(organization.body).toMatchObject({ deletion });
    await owner.post(`/api/org/${organizationId}/data-exports`).expect(202);
    const again = await owner
      .post(`/api/org/${organizationId}/deletion`)
      .send({ confirmName: NAME })
      .expect(409);
    expect(again.body).toMatchObject({ code: 'ORGANIZATION_DELETION_PENDING' });

    const [erasure] = await query<{ status: string; run_after: Date; details: unknown }>(
      `SELECT status, run_after, details FROM gdpr_request WHERE organization_id = $1 AND kind = 'ERASURE'`,
      [organizationId],
    );
    expect(erasure).toMatchObject({
      status: 'PENDING',
      details: { workspaceIds: [workspaceId], endsSubscription: true },
    });
    expect(erasure?.run_after.toISOString()).toBe(deletion.eraseAfter);
    await expect(auditActions()).resolves.toEqual(['organization.delete_requested']);
    expect(cancelsAtPeriodEnd()).toBe(true);

    // The email names the day in the language and the time zone of the owner.
    const [person] = await query<{ locale: string; timezone: string }>(
      'SELECT locale, timezone FROM users WHERE email = $1',
      ['deletion-owner@abschied.test'],
    );
    const day = new Intl.DateTimeFormat(person?.locale, {
      dateStyle: 'long',
      timeZone: person?.timezone,
    }).format(new Date(deletion.eraseAfter));
    const subject =
      person?.locale === 'en'
        ? `${NAME} will be erased for good on ${day}`
        : `${NAME} wird am ${day} endgültig gelöscht`;
    const message = await started().api.mailpit.waitForMessage('deletion-owner@abschied.test', { subject });
    expect(message.Text).toContain(`${APP_ORIGIN}/org/${organizationId}/data`);
  });

  it('takes the deletion back for the owners only, and everyone works again', async () => {
    const notOwner = await editor.delete(`/api/org/${organizationId}/deletion`).expect(403);
    expect(notOwner.body).toMatchObject({ code: 'NOT_PERMITTED' });

    await owner.delete(`/api/org/${organizationId}/deletion`).expect(204);

    await editor.get(`/api/w/${slug}/posts`).expect(200);
    await owner.get(`/api/org/${organizationId}/members`).expect(200);
    const context = await editor.get(`/api/w/${slug}`).expect(200);
    expect(context.body).toMatchObject({ deletion: null });
    const [erasure] = await query<{ status: string }>(
      `SELECT status FROM gdpr_request WHERE organization_id = $1 AND kind = 'ERASURE'`,
      [organizationId],
    );
    expect(erasure).toEqual({ status: 'CANCELED' });
    await expect(auditActions()).resolves.toEqual([
      'organization.delete_requested',
      'organization.delete_canceled',
    ]);
    expect(cancelsAtPeriodEnd()).toBe(false);

    const nothingWaits = await owner.delete(`/api/org/${organizationId}/deletion`).expect(409);
    expect(nothingWaits.body).toMatchObject({ code: 'ERASURE_NOT_PENDING' });
  });
});
