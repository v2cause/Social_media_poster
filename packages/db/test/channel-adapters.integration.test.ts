import { randomUUID } from 'node:crypto';

import type { ChannelScope, ChannelStore, ConnectionGrant } from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ChannelReadModel, createPrismaClient, PrismaChannelUnitOfWork, type PrismaClient } from '../src';

// The Prisma adapters of the channel ports against PostgreSQL with row-level security (guide step
// 4.5): connections and accounts of one workspace stay invisible to another, a new grant renews a
// connection, accounts come back under their id, and the read model shows no token. A browser
// connection of X keeps a session instead of tokens (guide step 6.4).

const orgA = randomUUID();
const orgB = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const userId = randomUUID();
const scopeA: ChannelScope = { userId, organizationId: orgA, workspaceId: workspaceA };
const scopeB: ChannelScope = { userId, organizationId: orgB, workspaceId: workspaceB };

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const grant = (overrides: Partial<ConnectionGrant> = {}): ConnectionGrant => ({
  displayName: 'Mira',
  accessTokenSealed: bytes('sealed-access'),
  refreshTokenSealed: bytes('sealed-refresh'),
  sessionSealed: null,
  accessTokenExpiresAt: new Date('2026-10-16T14:00:00Z'),
  refreshTokenExpiresAt: new Date('2027-04-14T12:00:00Z'),
  scopes: ['tweet.read', 'tweet.write'],
  connectedById: userId,
  grantedAt: new Date('2026-10-16T12:00:00Z'),
  ...overrides,
});

describe('channel adapters on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;
  const connectionId = randomUUID();
  const accountIds = [randomUUID(), randomUUID()] as const;

  const unitOfWork = (): PrismaChannelUnitOfWork => {
    if (!base) {
      throw new Error('database not ready');
    }
    return new PrismaChannelUnitOfWork(base, () => ({ ipAddress: '192.0.2.1', userAgent: 'vitest' }));
  };
  const inA = <T>(work: (store: ChannelStore) => Promise<T>): Promise<T> => unitOfWork().run(scopeA, work);
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    if (!database) {
      throw new Error('database not ready');
    }
    const connection = await database.connectAs('app_system');
    try {
      return (await connection.query(sql, values)).rows as T[];
    } finally {
      await connection.end();
    }
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`, [
      orgA,
      orgB,
    ]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'channels-a', 'A', 'Europe/Berlin', 'de', now()),
              ($3, $4, 'channels-b', 'B', 'Europe/Berlin', 'de', now())`,
      [workspaceA, orgA, workspaceB, orgB],
    );
    base = createPrismaClient(database.url('app_user'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await database?.stop();
  });

  it('stores a connection with its accounts and shows them in their workspace only', async () => {
    await inA(async (store) => {
      await store.connections.insert({
        id: connectionId,
        workspaceId: workspaceA,
        platform: 'X',
        method: 'MOCK',
        externalUserId: 'mira',
        ...grant(),
      });
      for (const [index, id] of accountIds.entries()) {
        await store.accounts.upsert({
          id,
          workspaceId: workspaceA,
          connectionId,
          platform: 'X',
          type: 'PROFILE',
          externalId: `x-${String(index)}`,
          name: `Account ${String(index)}`,
          handle: null,
          avatarUrl: null,
          accessTokenSealed: index === 0 ? bytes('sealed-page') : null,
          connectedById: userId,
        });
      }
      await store.audit.record({
        organizationId: orgA,
        workspaceId: workspaceA,
        action: 'channel.connect',
        targetType: 'SocialConnection',
        targetId: connectionId,
      });
    });

    const found = await inA((store) => store.connections.findByExternalUser(workspaceA, 'X', 'MOCK', 'mira'));
    expect(found).toMatchObject({
      id: connectionId,
      status: 'ACTIVE',
      scopes: ['tweet.read', 'tweet.write'],
    });
    expect(Buffer.from(found?.accessTokenSealed ?? []).toString()).toBe('sealed-access');
    const accounts = await inA((store) => store.accounts.findByExternalIds(workspaceA, 'X', ['x-0', 'x-1']));
    expect(accounts.map((account) => account.id).sort()).toEqual([...accountIds].sort());

    // Another workspace sees nothing, even when it asks for the ids.
    await expect(
      unitOfWork().run(scopeB, (store) => store.connections.find(workspaceA, connectionId)),
    ).resolves.toBeNull();
    await expect(
      unitOfWork().run(scopeB, (store) => store.accounts.findByExternalIds(workspaceA, 'X', ['x-0'])),
    ).resolves.toEqual([]);
    const [audit] = await query<{ actor_user_id: string; ip_address: string }>(
      `SELECT actor_user_id, ip_address FROM audit_log WHERE target_id = $1`,
      [connectionId],
    );
    expect(audit).toEqual({ actor_user_id: userId, ip_address: '192.0.2.1' });
  });

  it('renews a grant: active again, a new version and the reminders reset', async () => {
    await query(
      `UPDATE social_connection SET status = 'NEEDS_REAUTH', status_reason = 'REFRESH_FAILED', expiry_notice_days = 7
        WHERE id = $1`,
      [connectionId],
    );

    await inA((store) =>
      store.connections.replaceGrant(workspaceA, connectionId, grant({ scopes: ['tweet.read'] })),
    );

    const [row] = await query<Record<string, unknown>>(
      `SELECT status, status_reason, expiry_notice_days, scopes, version FROM social_connection WHERE id = $1`,
      [connectionId],
    );
    expect(row).toEqual({
      status: 'ACTIVE',
      status_reason: null,
      expiry_notice_days: null,
      scopes: ['tweet.read'],
      version: 1,
    });
  });

  it('disconnects an account once and connects it again under its id', async () => {
    const [first] = accountIds;
    await expect(inA((store) => store.accounts.disconnect(workspaceA, first, new Date()))).resolves.toBe(
      true,
    );
    await expect(inA((store) => store.accounts.disconnect(workspaceA, first, new Date()))).resolves.toBe(
      false,
    );
    await expect(inA((store) => store.accounts.connectedCount(workspaceA, connectionId))).resolves.toBe(1);
    const [dropped] = await query<{ access_token_sealed: Buffer | null }>(
      'SELECT access_token_sealed FROM social_account WHERE id = $1',
      [first],
    );
    expect(dropped?.access_token_sealed).toBeNull();

    await inA((store) =>
      store.accounts.upsert({
        id: first,
        workspaceId: workspaceA,
        connectionId,
        platform: 'X',
        type: 'PROFILE',
        externalId: 'x-0',
        name: 'Renamed',
        handle: 'renamed',
        avatarUrl: null,
        accessTokenSealed: null,
        connectedById: userId,
      }),
    );
    await expect(inA((store) => store.accounts.find(workspaceA, first))).resolves.toMatchObject({
      name: 'Renamed',
      disconnectedAt: null,
      version: 2,
    });
  });

  it('lists the connected accounts with the access expiry and without tokens', async () => {
    const [, second] = accountIds;
    await inA((store) => store.accounts.disconnect(workspaceA, second, new Date()));

    const views = await new ChannelReadModel(base as PrismaClient).accounts({
      organizationId: orgA,
      workspaceId: workspaceA,
    });

    expect(views).toEqual([
      {
        id: accountIds[0],
        connectionId,
        platform: 'X',
        method: 'MOCK',
        type: 'PROFILE',
        name: 'Renamed',
        handle: 'renamed',
        avatarUrl: null,
        status: 'ACTIVE',
        statusReason: null,
        // With a refresh token the access lasts as long as that one.
        accessExpiresAt: new Date('2027-04-14T12:00:00Z'),
        grantedScopes: ['tweet.read'],
        connectedAt: expect.any(Date) as Date,
        // An X account without paid calls so far.
        costMicros: 0,
      },
    ]);
    await expect(
      new ChannelReadModel(base as PrismaClient).accounts({ organizationId: orgB, workspaceId: workspaceB }),
    ).resolves.toEqual([]);
  });

  it('revokes a connection and drops its tokens', async () => {
    await inA((store) => store.connections.revoke(workspaceA, connectionId));

    await expect(inA((store) => store.connections.find(workspaceA, connectionId))).resolves.toMatchObject({
      status: 'REVOKED',
      accessTokenSealed: null,
      refreshTokenSealed: null,
    });
  });

  it('stores a browser connection of X with its session and the language of its account', async () => {
    const browserConnectionId = randomUUID();
    const browserAccountId = randomUUID();
    const login = grant({
      accessTokenSealed: null,
      refreshTokenSealed: null,
      sessionSealed: bytes('sealed-session'),
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scopes: [],
    });
    await inA(async (store) => {
      await store.connections.insert({
        id: browserConnectionId,
        workspaceId: workspaceA,
        platform: 'X',
        method: 'BROWSER',
        externalUserId: '1234567890',
        ...login,
      });
      await store.accounts.upsert({
        id: browserAccountId,
        workspaceId: workspaceA,
        connectionId: browserConnectionId,
        platform: 'X',
        type: 'PROFILE',
        externalId: '1234567890',
        name: 'SMP Demo',
        handle: 'smp_demo',
        avatarUrl: null,
        accessTokenSealed: null,
        connectedById: userId,
        settings: { locale: 'en' },
      });
    });
    await inA((store) =>
      store.connections.replaceGrant(workspaceA, browserConnectionId, {
        ...login,
        sessionSealed: bytes('sealed-session-2'),
      }),
    );

    const [row] = await query<{ access_token_sealed: Buffer | null; session_sealed: Buffer }>(
      'SELECT access_token_sealed, session_sealed FROM social_connection WHERE id = $1',
      [browserConnectionId],
    );
    expect(row?.access_token_sealed).toBeNull();
    expect(row?.session_sealed.toString()).toBe('sealed-session-2');
    const [account] = await query<{ settings: unknown }>(
      'SELECT settings FROM social_account WHERE id = $1',
      [browserAccountId],
    );
    expect(account?.settings).toEqual({ locale: 'en' });
  });
});
