import { randomUUID } from 'node:crypto';

import { connectionSecretAad, DeliverNotification, type NotificationEmail } from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  PrismaNotificationDirectory,
  PrismaNotificationInbox,
  type PrismaClient,
} from '../src';

// Guide step 4.9 on PostgreSQL: the notification of an event reaches the managers of a
// connection or the author of a post, once, as each of them wants it, and stays readable for
// its user only.

const NOW = new Date('2026-10-16T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const org = randomUUID();
const workspace = randomUUID();
const users = { owner: randomUUID(), admin: randomUUID(), editor: randomUUID() };

describe('notifications on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;

  const ready = () => {
    if (!database || !base) {
      throw new Error('database not ready');
    }
    return { database, base };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    if (!database) {
      throw new Error('database not started');
    }
    const connection = await database.connectAs('app_system');
    try {
      return (await connection.query(sql, values)).rows as T[];
    } finally {
      await connection.end();
    }
  };

  /** A LinkedIn connection without refresh token, one account, and a scheduled post of the editor. */
  const seed = async (status: 'ACTIVE' | 'EXPIRING', expiresInDays: number) => {
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const postId = randomUUID();
    const scheduled = randomUUID();
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, status, external_user_id, display_name,
                                      access_token_sealed, access_token_expires_at, updated_at)
       VALUES ($1, $2, 'LINKEDIN', 'API', $3, $4, 'Mira', $5, $6, now())`,
      [
        connectionId,
        workspace,
        status,
        `user-${connectionId}`,
        Buffer.from(`${connectionSecretAad(workspace, connectionId, 'access_token')}|access-1`),
        new Date(NOW.getTime() + expiresInDays * DAY_MS),
      ],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', 'PROFILE', $4, 'Mira Becker', now())`,
      [accountId, workspace, connectionId, `urn:li:person:${accountId}`],
    );
    await query(
      `INSERT INTO post (id, workspace_id, brief, language, created_by_id, updated_at)
       VALUES ($1, $2, 'Brief', 'de', $3, now())`,
      [postId, workspace, users.editor],
    );
    await query(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, text, social_account_id, status,
                                 scheduled_at, updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', 't1', 'Wir suchen Verstärkung im Kundendienst.', $4, 'SCHEDULED',
               $5, now())`,
      [scheduled, workspace, postId, accountId, new Date(NOW.getTime() + 2 * DAY_MS)],
    );
    return { connectionId, accountId, postId, scheduled };
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Nordlicht', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'nordlicht-notify', 'Nordlicht', 'Europe/Berlin', 'de', now())`,
      [workspace, org],
    );
    for (const [role, id] of Object.entries(users)) {
      await query(`INSERT INTO users (id, name, email, locale, updated_at) VALUES ($1, $2, $3, $4, now())`, [
        id,
        role === 'admin' ? '' : role,
        `${role}-${id}@demo.local`,
        role === 'admin' ? 'en' : 'de',
      ]);
      await query(
        `INSERT INTO membership (id, organization_id, user_id, role, updated_at) VALUES ($1, $2, $3, $4, now())`,
        [randomUUID(), org, id, role.toUpperCase()],
      );
    }
    base = createPrismaClient(database.url('app_user'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await database?.stop();
  });

  it('delivers to the managers and the author, once, as each of them wants it', async () => {
    const { connectionId, scheduled } = await seed('EXPIRING', 6);
    await query(
      `INSERT INTO notification_preference (user_id, type, channel, enabled) VALUES ($1, 'token-expiring', 'EMAIL', false)`,
      [users.admin],
    );
    const emails: NotificationEmail[] = [];
    const deliver = new DeliverNotification({
      directory: new PrismaNotificationDirectory(ready().base),
      inbox: new PrismaNotificationInbox(ready().base),
      mailer: {
        send: (email) => {
          emails.push(email);
          return Promise.resolve();
        },
      },
    });
    const tokenEvent = {
      eventId: randomUUID(),
      organizationId: org,
      workspaceId: workspace,
      request: {
        type: 'token-expiring' as const,
        connectionId,
        daysLeft: 7,
        expiresAt: new Date(NOW.getTime() + 6 * DAY_MS).toISOString(),
      },
    };

    await expect(deliver.execute(tokenEvent)).resolves.toEqual({ recipients: 2, inApp: 2, emails: 1 });
    await expect(deliver.execute(tokenEvent)).resolves.toEqual({ recipients: 2, inApp: 0, emails: 1 });
    expect(
      emails.map((email) => [email.recipient.userId, email.recipient.locale, email.workspace.slug]),
    ).toEqual([
      [users.owner, 'de', 'nordlicht-notify'],
      [users.owner, 'de', 'nordlicht-notify'],
    ]);
    expect(emails[0]?.content).toMatchObject({
      platform: 'LINKEDIN',
      accounts: ['Mira Becker'],
      daysLeft: 7,
    });

    const failed = await deliver.execute({
      eventId: randomUUID(),
      organizationId: org,
      workspaceId: workspace,
      request: { type: 'publish-failed', variantId: scheduled, failureCode: 'MISSED_WINDOW' },
    });
    expect(failed).toEqual({ recipients: 1, inApp: 1, emails: 1 });
    expect(emails.at(-1)).toMatchObject({
      recipient: { userId: users.editor },
      content: { type: 'publish-failed', preview: 'Wir suchen Verstärkung im Kundendienst.' },
    });

    // Each user reads their own notifications only.
    const visibleTo = async (userId: string) => {
      const client = await ready().database.connectAs('app_user');
      try {
        await client.query("SELECT set_config('app.user_id', $1, false)", [userId]);
        return (await client.query<{ type: string }>('SELECT type FROM notification ORDER BY created_at'))
          .rows;
      } finally {
        await client.end();
      }
    };
    expect(await visibleTo(users.editor)).toEqual([{ type: 'publish-failed' }]);
    expect(await visibleTo(users.admin)).toEqual([{ type: 'token-expiring' }]);
  });
});
