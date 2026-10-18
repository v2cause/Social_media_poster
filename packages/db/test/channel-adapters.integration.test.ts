import { randomUUID } from 'node:crypto';

import {
  ConfirmConnection,
  pendingSecretAad,
  PlanLimitReachedError,
  uuidV7Ids,
  type AccountLimits,
  type ChannelScope,
  type ChannelStore,
  type ConnectionGrant,
  type PendingConnection,
  type SecretSealer,
} from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ChannelReadModel,
  createPrismaClient,
  createSystemPrismaClient,
  PrismaChannelUnitOfWork,
  PrismaPlanUsage,
  type PrismaClient,
  type SystemPrismaClient,
} from '../src';

// The Prisma adapters of the channel ports against PostgreSQL with row-level security (guide step
// 4.5): connections and accounts of one workspace stay invisible to another, a new grant renews a
// connection, accounts come back under their id, and the read model shows no token. A browser
// connection of X keeps a session instead of tokens (guide step 6.4). Parallel confirmations stay
// within the accounts of the plan (guide step 8.4).

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
/** Binds the AAD like the keyring, without keys. */
const sealer: SecretSealer = {
  seal: (plaintext, aad) => Promise.resolve(bytes(`${aad}|${plaintext}`)),
  open(sealed, aad) {
    const text = new TextDecoder().decode(sealed);
    return text.startsWith(`${aad}|`)
      ? Promise.resolve(text.slice(aad.length + 1))
      : Promise.reject(new Error('INVALID'));
  },
};

describe('channel adapters on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;
  let system: SystemPrismaClient | undefined;
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
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await system?.$disconnect();
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

  it('keeps parallel confirmations of an organization within the accounts of its plan', async () => {
    const organizationId = randomUUID();
    const workspaces = [randomUUID(), randomUUID()] as const;
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'C', now())`, [organizationId]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $3, 'channels-c1', 'C1', 'Europe/Berlin', 'de', now()),
              ($2, $3, 'channels-c2', 'C2', 'Europe/Berlin', 'de', now())`,
      [...workspaces, organizationId],
    );
    // One account is connected already, and the plan allows two.
    const connected = randomUUID();
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                      access_token_sealed, updated_at)
       VALUES ($1, $2, 'LINKEDIN', 'MOCK', 'ada', 'Ada', '\\x00', now())`,
      [connected, workspaces[0]],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'LINKEDIN', 'PROFILE', 'urn:li:person:ada', 'Ada', now())`,
      [workspaces[0], connected],
    );
    const accountsWithin = (max: number): AccountLimits => ({
      async assertRoom(organization, adding) {
        if (!system) {
          throw new Error('database not ready');
        }
        const used = await new PrismaPlanUsage(system).socialAccounts(organization);
        if (adding > 0 && used + adding > max) {
          throw new PlanLimitReachedError('maxSocialAccounts', max);
        }
      },
    });
    // Three consents waiting for their selection, two in the first workspace and one in the second.
    const pendings = new Map<string, PendingConnection>();
    for (const [index, workspaceId] of [workspaces[0], workspaces[0], workspaces[1]].entries()) {
      const id = randomUUID();
      pendings.set(id, {
        id,
        userId,
        organizationId,
        workspaceId,
        platform: 'LINKEDIN',
        method: 'MOCK',
        externalUserId: `user-${String(index)}`,
        displayName: `User ${String(index)}`,
        requestedScopes: [],
        grantedScopes: [],
        accounts: [
          {
            externalId: `urn:li:person:${String(index)}`,
            type: 'PROFILE',
            name: 'P',
            handle: null,
            avatarUrl: null,
          },
        ],
        sealedSecrets: await sealer.seal(
          JSON.stringify({
            accessToken: 'access',
            refreshToken: null,
            accessTokenExpiresAt: null,
            refreshTokenExpiresAt: null,
            accounts: {},
          }),
          pendingSecretAad(workspaceId, id),
        ),
        reconnectAccountId: null,
        expiresAt: new Date('2026-10-16T12:15:00Z'),
      });
    }
    const confirm = new ConfirmConnection({
      unitOfWork: unitOfWork(),
      pendings: {
        save: (pending) => {
          pendings.set(pending.id, pending);
          return Promise.resolve();
        },
        find: (id) => Promise.resolve(pendings.get(id) ?? null),
        delete: (id) => {
          pendings.delete(id);
          return Promise.resolve();
        },
      },
      sealer,
      clock: { now: () => new Date('2026-10-16T12:00:00Z') },
      ids: uuidV7Ids,
      accounts: accountsWithin(2),
    });

    const outcomes = await Promise.allSettled(
      [...pendings.values()].map((pending) =>
        confirm.execute({
          actor: { userId, organizationId, workspaceId: pending.workspaceId, role: 'OWNER' },
          pendingId: pending.id,
          externalIds: pending.accounts.map((account) => account.externalId),
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(refused).toHaveLength(2);
    for (const outcome of refused) {
      expect(outcome.reason).toBeInstanceOf(PlanLimitReachedError);
    }
    await expect(
      new PrismaPlanUsage(system as SystemPrismaClient).socialAccounts(organizationId),
    ).resolves.toBe(2);
  });
});
