import { randomUUID } from 'node:crypto';

import type { NotificationPageDto, NotificationPreferencesDto } from '@smp/contracts';
import { createPrismaClient, DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '@smp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { browser, signIn, type Browser } from './support/browser';

// Guide step 4.9: the bell lists the notifications of the signed-in user (only those of the
// workspaces the user may open), marks them read, and the account page sets per type how they
// arrive. Nobody reads or marks the notifications of another user.

const SEED_PASSWORD = 'seed-password-for-the-notifications-test';

const userOf = (role: string) => {
  const user = DEMO_USERS.find((candidate) => candidate.role === role);
  if (!user) {
    throw new Error(`no demo user with role ${role}`);
  }
  return user;
};

describe('notifications API', () => {
  let api: ApiTestApp | undefined;
  let editor: Browser | undefined;
  let viewer: Browser | undefined;
  const ids = { organization: '', workspace: '', editor: '' };
  const notifications: string[] = [];

  const as = (agent: Browser | undefined): Browser => {
    if (!agent) {
      throw new Error('not signed in');
    }
    return agent;
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    if (!api) {
      throw new Error('API is not running');
    }
    const connection = await api.database.connectAs('app_system');
    try {
      return (await connection.query(sql, values)).rows as T[];
    } finally {
      await connection.end();
    }
  };
  const addNotification = async (
    workspace: { organizationId: string; workspaceId: string },
    payload: Record<string, unknown>,
    minutesAgo: number,
  ): Promise<string> => {
    const id = randomUUID();
    await query(
      `INSERT INTO notification (id, user_id, organization_id, workspace_id, type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(mins => $7::int))`,
      [
        id,
        ids.editor,
        workspace.organizationId,
        workspace.workspaceId,
        payload['type'],
        JSON.stringify(payload),
        minutesAgo,
      ],
    );
    return id;
  };

  beforeAll(async () => {
    api = await startApiTestApp();
    const system = createPrismaClient(api.database.url('app_system'));
    try {
      const seeded = await seedDemoData(system, SEED_PASSWORD);
      ids.organization = seeded.organizationId;
      ids.workspace = seeded.workspaceId;
      ids.editor = (await system.user.findUniqueOrThrow({ where: { email: userOf('EDITOR').email } })).id;
    } finally {
      await system.$disconnect();
    }
    editor = await signIn(api, userOf('EDITOR').email, SEED_PASSWORD);
    viewer = await signIn(api, userOf('VIEWER').email, SEED_PASSWORD);

    const own = { organizationId: ids.organization, workspaceId: ids.workspace };
    notifications.push(
      await addNotification(
        own,
        {
          type: 'publish-failed',
          postId: randomUUID(),
          variantId: randomUUID(),
          platform: 'LINKEDIN',
          accounts: ['Demo Nordlicht'],
          preview: 'Wir suchen Verstärkung.',
          failureCode: 'MISSED_WINDOW',
        },
        3,
      ),
      await addNotification(
        own,
        {
          type: 'reauth-required',
          connectionId: randomUUID(),
          platform: 'X',
          accounts: ['@nordlicht'],
          reason: 'EXPIRED',
          scheduledVariants: 2,
        },
        2,
      ),
    );
    // A content that no longer fits its contract is left out of the list.
    await addNotification(own, { type: 'publish-failed', preview: 'old shape' }, 4);
    // A notification of a workspace the editor may not open stays hidden.
    const otherOrg = randomUUID();
    const otherWorkspace = randomUUID();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Elsewhere', now())`, [
      otherOrg,
    ]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'elsewhere', 'Elsewhere', 'UTC', 'en', now())`,
      [otherWorkspace, otherOrg],
    );
    await addNotification(
      { organizationId: otherOrg, workspaceId: otherWorkspace },
      {
        type: 'needs-attention',
        postId: randomUUID(),
        variantId: randomUUID(),
        platform: 'FACEBOOK',
        accounts: ['Elsewhere'],
        preview: 'Hidden',
        failureCode: 'OUTCOME_UNKNOWN',
      },
      0,
    );
  }, 300_000);

  afterAll(async () => {
    await api?.close();
  });

  it('lists the notifications of the workspaces the user may open, newest first, page by page', async () => {
    const first = (await as(editor).get('/api/me/notifications?limit=1').expect(200))
      .body as NotificationPageDto;
    expect(first.items).toEqual([
      {
        id: notifications[1],
        createdAt: expect.any(String) as unknown,
        readAt: null,
        workspace: { slug: DEMO_WORKSPACE_SLUG, name: expect.any(String) as unknown },
        content: expect.objectContaining({ type: 'reauth-required', scheduledVariants: 2 }) as unknown,
      },
    ]);
    expect(first.unread).toBe(3);
    const second = (
      await as(editor)
        .get(`/api/me/notifications?limit=5&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
        .expect(200)
    ).body as NotificationPageDto;
    expect(second.items.map((item) => item.id)).toEqual([notifications[0]]);
    expect(second.nextCursor).toBeNull();
    const forged = await as(editor).get('/api/me/notifications?cursor=broken').expect(422);
    expect(forged.body).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('marks notifications read, its own only', async () => {
    const [failed, reauth] = notifications;
    expect(
      (
        await as(viewer)
          .post('/api/me/notifications/read')
          .send({ ids: [failed] })
          .expect(200)
      ).body,
    ).toEqual({ marked: 0 });
    expect(
      (
        await as(editor)
          .post('/api/me/notifications/read')
          .send({ ids: [failed] })
          .expect(200)
      ).body,
    ).toEqual({ marked: 1 });
    expect((await as(editor).get('/api/me/notifications/unread-count').expect(200)).body).toEqual({
      unread: 2,
    });
    const unread = (await as(editor).get('/api/me/notifications?unread=true').expect(200))
      .body as NotificationPageDto;
    expect(unread.items.map((item) => item.id)).toEqual([reauth]);

    expect((await as(editor).post('/api/me/notifications/read-all').expect(200)).body).toMatchObject({
      marked: 3,
    });
    expect((await as(editor).get('/api/me/notifications/unread-count').expect(200)).body).toEqual({
      unread: 0,
    });
    await as(editor).post('/api/me/notifications/read').send({ ids: [] }).expect(400);
    await as(viewer).get('/api/me/notifications').expect(200, { items: [], nextCursor: null, unread: 0 });
  });

  it('keeps the settings of each type, both channels on by default', async () => {
    const defaults = (await as(editor).get('/api/me/notification-preferences').expect(200))
      .body as NotificationPreferencesDto;
    expect(defaults.preferences).toEqual([
      { type: 'token-expiring', inApp: true, email: true },
      { type: 'reauth-required', inApp: true, email: true },
      { type: 'publish-failed', inApp: true, email: true },
      { type: 'needs-attention', inApp: true, email: true },
    ]);

    const changed = (
      await as(editor)
        .put('/api/me/notification-preferences')
        .send({ preferences: [{ type: 'publish-failed', inApp: true, email: false }] })
        .expect(200)
    ).body as NotificationPreferencesDto;
    expect(changed.preferences).toContainEqual({ type: 'publish-failed', inApp: true, email: false });
    expect(changed.preferences).toHaveLength(4);
    const [row] = await query<{ enabled: boolean }>(
      `SELECT enabled FROM notification_preference WHERE user_id = $1 AND type = 'publish-failed' AND channel = 'EMAIL'`,
      [ids.editor],
    );
    expect(row?.enabled).toBe(false);

    const duplicate = { type: 'publish-failed', inApp: false, email: false };
    await as(editor)
      .put('/api/me/notification-preferences')
      .send({ preferences: [duplicate, duplicate] })
      .expect(400);
    await as(editor)
      .put('/api/me/notification-preferences')
      .send({ preferences: [{ type: 'weekly-digest', inApp: true, email: true }] })
      .expect(400);
  });

  it('answers 401 without a session', async () => {
    if (!api) {
      throw new Error('API is not running');
    }
    await browser(api.server).get('/api/me/notifications').expect(401);
    await browser(api.server).put('/api/me/notification-preferences').send({ preferences: [] }).expect(401);
  });
});
