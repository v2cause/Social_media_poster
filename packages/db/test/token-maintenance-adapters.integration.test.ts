import { randomUUID } from 'node:crypto';

import {
  connectionSecretAad,
  MonitorTokens,
  RefreshConnection,
  type RefreshOutcome,
  type SecretSealer,
  type SocialPlatformAdapter,
} from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  createSystemPrismaClient,
  PrismaChannelUnitOfWork,
  PrismaExpiringConnectionScanner,
  PrismaTokenMaintenanceUnitOfWork,
  type PrismaClient,
  type SystemPrismaClient,
} from '../src';

// Guide step 4.9 on PostgreSQL: tick.tokens reminds once per stage and asks for a new grant after
// the expiry, marking the scheduled variants; token.refresh renews under the lock; a new grant
// takes the marks off.

const NOW = new Date('2026-10-16T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const org = randomUUID();
const workspace = randomUUID();
const users = { owner: randomUUID(), admin: randomUUID(), editor: randomUUID() };

const sealer: SecretSealer = {
  seal: (plaintext, aad) => Promise.resolve(new TextEncoder().encode(`${aad}|${plaintext}`)),
  open(sealed, aad) {
    const text = new TextDecoder().decode(sealed);
    return text.startsWith(`${aad}|`)
      ? Promise.resolve(text.slice(aad.length + 1))
      : Promise.reject(new Error('INVALID'));
  },
};

const adapterWith = (answer: RefreshOutcome): SocialPlatformAdapter => ({
  platform: 'LINKEDIN',
  method: 'API',
  connector: {
    scopes: [],
    usesPkce: false,
    authorizationUrl: () => '',
    exchangeCode: () => Promise.reject(new Error('not used')),
    listConnectableAccounts: () => Promise.resolve([]),
    revoke: () => Promise.resolve(),
  },
  capabilities: () => {
    throw new Error('not used');
  },
  refreshCredentials: () => Promise.resolve(answer),
  validatePost: () => [],
  publish: () => Promise.reject(new Error('not used')),
  reconcile: () => Promise.resolve(null),
  deletePost: () => Promise.reject(new Error('not used')),
  fetchPostMetrics: () => Promise.reject(new Error('not used')),
  fetchAccountMetrics: () => Promise.reject(new Error('not used')),
});

describe('the token monitor on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;
  let system: SystemPrismaClient | undefined;

  const ready = () => {
    if (!database || !base || !system) {
      throw new Error('database not ready');
    }
    return { database, base, system };
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
  const clock = { now: () => NOW };

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
  const monitor = (requested: string[] = []) =>
    new MonitorTokens({
      scanner: new PrismaExpiringConnectionScanner(ready().system),
      unitOfWork: new PrismaTokenMaintenanceUnitOfWork(ready().base),
      refreshes: {
        request: (job) => {
          requested.push(job.connectionId);
          return Promise.resolve();
        },
      },
      clock,
    });
  const eventsOf = (connectionId: string) =>
    query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_event
        WHERE type = 'notification.requested' AND payload->>'connectionId' = $1 ORDER BY created_at, id`,
      [connectionId],
    );

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Nordlicht', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'nordlicht-tokens', 'Nordlicht', 'Europe/Berlin', 'de', now())`,
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
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await system?.$disconnect();
    await database?.stop();
  });

  it('reminds once per stage and asks for a new grant after the expiry, marking the scheduled variants', async () => {
    const { connectionId, scheduled } = await seed('EXPIRING', 6);

    await monitor().execute();
    await monitor().execute();
    expect(await eventsOf(connectionId)).toEqual([
      {
        payload: {
          type: 'token-expiring',
          connectionId,
          daysLeft: 7,
          expiresAt: new Date(NOW.getTime() + 6 * DAY_MS).toISOString(),
        },
      },
    ]);
    expect(
      await query('SELECT expiry_notice_days FROM social_connection WHERE id = $1', [connectionId]),
    ).toEqual([{ expiry_notice_days: 7 }]);

    await query('UPDATE social_connection SET access_token_expires_at = $2 WHERE id = $1', [
      connectionId,
      new Date(NOW.getTime() - 60_000),
    ]);
    await expect(monitor().execute()).resolves.toMatchObject({ expired: 1 });

    expect(
      await query('SELECT status, status_reason FROM social_connection WHERE id = $1', [connectionId]),
    ).toEqual([{ status: 'NEEDS_REAUTH', status_reason: 'EXPIRED' }]);
    expect(await query('SELECT status, failure_code FROM post_variant WHERE id = $1', [scheduled])).toEqual([
      { status: 'SCHEDULED', failure_code: 'REAUTH_REQUIRED' },
    ]);
    expect((await eventsOf(connectionId)).at(-1)?.payload).toEqual({
      type: 'reauth-required',
      connectionId,
      reason: 'EXPIRED',
      scheduledVariants: 1,
    });

    // A new grant takes the mark off.
    await new PrismaChannelUnitOfWork(ready().base).run(
      { userId: users.owner, organizationId: org, workspaceId: workspace },
      (store) =>
        store.connections.replaceGrant(workspace, connectionId, {
          displayName: 'Mira',
          accessTokenSealed: new Uint8Array([1]),
          refreshTokenSealed: null,
          accessTokenExpiresAt: new Date(NOW.getTime() + 60 * DAY_MS),
          refreshTokenExpiresAt: null,
          scopes: [],
          connectedById: users.owner,
          grantedAt: NOW,
        }),
    );
    expect(await query('SELECT failure_code FROM post_variant WHERE id = $1', [scheduled])).toEqual([
      { failure_code: null },
    ]);
  });

  it('asks for the refresh of an active connection and renews it under its lock', async () => {
    const { connectionId } = await seed('ACTIVE', 10);
    const requested: string[] = [];

    await monitor(requested).execute();
    expect(requested).toContain(connectionId);

    const locked: string[] = [];
    const refresh = new RefreshConnection({
      unitOfWork: new PrismaTokenMaintenanceUnitOfWork(ready().base),
      adapters: {
        resolve: () =>
          Promise.resolve(
            adapterWith({
              status: 'refreshed',
              tokens: {
                accessToken: 'access-2',
                refreshToken: null,
                accessTokenExpiresAt: new Date(NOW.getTime() + 60 * DAY_MS),
                refreshTokenExpiresAt: null,
                scopes: ['w_member_social'],
              },
            }),
          ),
      },
      sealer,
      locks: {
        withConnectionLock: (id, work) => {
          locked.push(id);
          return work();
        },
      },
      clock,
      logger: { info: () => undefined, warn: () => undefined },
    });

    await expect(
      refresh.execute({ organizationId: org, workspaceId: workspace, connectionId }),
    ).resolves.toBe('refreshed');
    expect(locked).toEqual([connectionId]);
    const [row] = await query<Record<string, unknown>>(
      `SELECT status, access_token_sealed, access_token_expires_at, scopes, last_refreshed_at, expiry_notice_days
         FROM social_connection WHERE id = $1`,
      [connectionId],
    );
    expect(row).toEqual({
      status: 'ACTIVE',
      access_token_sealed: Buffer.from(
        `${connectionSecretAad(workspace, connectionId, 'access_token')}|access-2`,
      ),
      access_token_expires_at: new Date(NOW.getTime() + 60 * DAY_MS),
      scopes: ['w_member_social'],
      last_refreshed_at: NOW,
      expiry_notice_days: null,
    });
  });
});
