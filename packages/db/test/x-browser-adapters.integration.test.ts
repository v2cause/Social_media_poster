import { randomUUID } from 'node:crypto';

import { X_BROWSER_FLAG } from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  createSystemPrismaClient,
  PrismaXBrowserAdminStore,
  PrismaXBrowserOperations,
  PrismaXBrowserUnitOfWork,
  type PrismaClient,
  type SystemPrismaClient,
} from '../src';

// Guide steps 6.1 and 6.5 on PostgreSQL: a workspace reads the kill switch, the gate of its
// organization and its own flag and writes only its own, keeps one row per flag also under
// concurrent writes, and records and revokes risk acknowledgements; the platform admins set the
// kill switch and the gates of the organizations as app_system, where the circuit breaker finds
// the admins to alert and the canary its test account.

const orgA = randomUUID();
const orgB = randomUUID();
const wsA = randomUUID();
const wsB = randomUUID();
const user = randomUUID();
const scopeA = { userId: user, organizationId: orgA, workspaceId: wsA };
const scopeB = { organizationId: orgB, workspaceId: wsB };

describe('X browser adapters', () => {
  let database: TestDatabase | undefined;
  let prisma: PrismaClient | undefined;
  let system: SystemPrismaClient | undefined;

  const required = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) {
      throw new Error(`${name} is not ready`);
    }
    return value;
  };
  const unitOfWork = () =>
    new PrismaXBrowserUnitOfWork(required(prisma, 'prisma'), () => ({ ipAddress: '203.0.113.7' }));
  const admin = () => new PrismaXBrowserAdminStore(required(system, 'system'));
  // app_system sees past row-level security, which applies to the owner as well.
  const flagRows = async (workspaceId: string | null, organizationId: string | null): Promise<number> => {
    const owner = await required(database, 'database').connectAs('app_system');
    try {
      const { rows } = await owner.query<{ count: string }>(
        `SELECT count(*) FROM feature_flag
          WHERE key = $1 AND workspace_id IS NOT DISTINCT FROM $2 AND organization_id IS NOT DISTINCT FROM $3`,
        [X_BROWSER_FLAG, workspaceId, organizationId],
      );
      return Number(rows[0]?.count ?? 0);
    } finally {
      await owner.end();
    }
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    const owner = await database.connectAs('app_system');
    try {
      await owner.query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Demo GmbH', now()), ($2, 'B', now())`,
        [orgA, orgB],
      );
      await owner.query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $2, 'xb-demo', 'Demo', 'Europe/Berlin', 'de', now()),
                ($3, $4, 'xb-other', 'B', 'Europe/Berlin', 'de', now())`,
        [wsA, orgA, wsB, orgB],
      );
      await owner.query(
        `INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
         VALUES ($1, 'olga@example.test', 'Olga Owner', true, now(), now())`,
        [user],
      );
    } finally {
      await owner.end();
    }
    prisma = createPrismaClient(database.url('app_user'));
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await system?.$disconnect();
    await database?.stop();
  });

  it('starts without flags and keeps one row per flag of the workspace, also under concurrent writes', async () => {
    const flagsOf = () => unitOfWork().run(scopeA, (store) => store.flags(orgA, wsA));
    await expect(flagsOf()).resolves.toEqual({ global: null, organization: null, workspace: null });

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        unitOfWork().run(scopeA, (store) => store.setWorkspaceFlag(orgA, wsA, index % 2 === 0)),
      ),
    );
    expect(await flagRows(wsA, orgA)).toBe(1);
    await unitOfWork().run(scopeA, (store) => store.setWorkspaceFlag(orgA, wsA, true));
    await expect(flagsOf()).resolves.toEqual({ global: null, organization: null, workspace: true });
  });

  it('lets the platform admins set the kill switch and the gates of the organizations', async () => {
    const store = admin();
    await expect(store.globalFlag()).resolves.toBeNull();
    await store.setGlobalFlag(false);
    await store.setGlobalFlag(false);
    expect(await flagRows(null, null)).toBe(1);
    await expect(store.globalFlag()).resolves.toMatchObject({ enabled: false });

    await expect(store.organizationOfWorkspace('xb-demo')).resolves.toEqual({ id: orgA, name: 'Demo GmbH' });
    await expect(store.organizationOfWorkspace('missing')).resolves.toBeNull();
    await expect(store.setOrganizationFlag(orgA, true)).resolves.toBe(true);
    await expect(store.setOrganizationFlag(randomUUID(), true)).resolves.toBe(false);
    const allowed = await store.allowedOrganizations();
    expect(allowed.map(({ id, name }) => ({ id, name }))).toEqual([{ id: orgA, name: 'Demo GmbH' }]);

    // The workspace sees both switches; the other organization only the kill switch.
    await expect(unitOfWork().run(scopeA, (s) => s.flags(orgA, wsA))).resolves.toEqual({
      global: false,
      organization: true,
      workspace: true,
    });
    await expect(unitOfWork().run(scopeB, (s) => s.flags(orgB, wsB))).resolves.toEqual({
      global: false,
      organization: null,
      workspace: null,
    });

    await store.setGlobalFlag(true);
    await store.setOrganizationFlag(orgA, false);
    await expect(store.allowedOrganizations()).resolves.toEqual([]);
  });

  it('reads whether the plan of the organization includes the X browser (guide step 7.4)', async () => {
    const owner = await database?.connectAs('app_system');
    const planAllows = (scope: typeof scopeA | typeof scopeB, organizationId: string) =>
      unitOfWork().run(scope, (store) => store.planAllows(organizationId));
    try {
      // Without a subscription, and in the trial, it does not.
      await expect(planAllows(scopeA, orgA)).resolves.toBe(false);
      await owner?.query(
        `INSERT INTO subscription (id, organization_id, plan_key, status, updated_at)
         VALUES (gen_random_uuid(), $1, 'pro', 'ACTIVE', now()), (gen_random_uuid(), $2, 'starter', 'ACTIVE', now())`,
        [orgA, orgB],
      );
      await expect(planAllows(scopeA, orgA)).resolves.toBe(true);
      await expect(planAllows(scopeB, orgB)).resolves.toBe(false);
      await owner?.query(
        `UPDATE subscription SET limit_overrides = '{"xBrowserAllowed": true}' WHERE organization_id = $1`,
        [orgB],
      );
      await expect(planAllows(scopeB, orgB)).resolves.toBe(true);
      // Another organization stays invisible.
      await expect(planAllows(scopeB, orgA)).resolves.toBe(false);
    } finally {
      await owner?.query('DELETE FROM subscription WHERE organization_id = ANY($1)', [[orgA, orgB]]);
      await owner?.end();
    }
  });

  it('lets the circuit breaker switch the global flag off once, also when two drifts come at once', async () => {
    const store = admin();
    await store.setGlobalFlag(true);
    const closed = await Promise.all([store.closeGlobalFlag(), store.closeGlobalFlag()]);
    expect(closed.sort()).toEqual([false, true]);
    await expect(store.globalFlag()).resolves.toMatchObject({ enabled: false });
    expect(await flagRows(null, null)).toBe(1);

    await store.setGlobalFlag(true);
    await expect(store.closeGlobalFlag()).resolves.toBe(true);
    await store.setGlobalFlag(true);
  });

  it('finds the platform admins to alert and the test account of the canary', async () => {
    const operations = new PrismaXBrowserOperations(required(system, 'system'));
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const owner = await required(database, 'database').connectAs('app_system');
    try {
      await owner.query(
        `INSERT INTO users (id, email, name, email_verified, locale, is_platform_admin, created_at, updated_at)
         VALUES ($1, 'ops@example.test', 'Ops', true, 'en', true, now(), now()),
                ($2, 'unconfirmed@example.test', 'Unconfirmed', false, 'de', true, now(), now())`,
        [randomUUID(), randomUUID()],
      );
      await owner.query(
        `INSERT INTO social_connection
           (id, workspace_id, platform, method, external_user_id, display_name, session_sealed, updated_at)
         VALUES ($1, $2, 'X', 'BROWSER', '1846000000000000777', 'Canary', '\\x0102'::bytea, now())`,
        [connectionId, wsA],
      );
      await owner.query(
        `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, handle,
                                     settings, updated_at)
         VALUES ($1, $2, $3, 'X', 'PROFILE', '1846000000000000777', 'Canary', 'smp_canary', '{"locale":"en"}', now())`,
        [accountId, wsA, connectionId],
      );
    } finally {
      await owner.end();
    }

    await expect(operations.platformAdmins()).resolves.toEqual([
      { email: 'ops@example.test', name: 'Ops', locale: 'en' },
    ]);
    await expect(operations.canaryAccount(accountId)).resolves.toEqual({
      organizationId: orgA,
      workspaceId: wsA,
      connectionId,
      accountId,
      externalUserId: '1846000000000000777',
      handle: 'smp_canary',
      settings: { locale: 'en' },
      sessionSealed: Uint8Array.from([1, 2]),
    });
    await expect(operations.canaryAccount(randomUUID())).resolves.toBeNull();
  });

  it('refuses a flag of another workspace', async () => {
    await expect(
      unitOfWork().run(scopeA, (store) => store.setWorkspaceFlag(orgB, wsB, true)),
    ).rejects.toThrow(/row-level security/);
    expect(await flagRows(wsB, orgB)).toBe(0);
  });

  it('replaces the sealed session of its browser connection of X only', async () => {
    const connectionId = randomUUID();
    const owner = await required(database, 'database').connectAs('app_system');
    try {
      await owner.query(
        `INSERT INTO social_connection
           (id, workspace_id, platform, method, external_user_id, display_name, session_sealed, updated_at)
         VALUES ($1, $2, 'X', 'BROWSER', '1234567890', 'SMP Demo', '\\x01'::bytea, now())`,
        [connectionId, wsA],
      );
    } finally {
      await owner.end();
    }
    const replace = (scope: typeof scopeA | typeof scopeB, workspaceId: string, externalUserId: string) =>
      unitOfWork().run(scope, (store) =>
        store.replaceSession(workspaceId, connectionId, externalUserId, Uint8Array.from([2, 3])),
      );

    await expect(replace(scopeA, wsA, '1234567890')).resolves.toBe(true);
    await expect(replace(scopeA, wsA, '999')).resolves.toBe(false);
    // Another workspace does not see the connection.
    await expect(replace(scopeB, wsB, '1234567890')).resolves.toBe(false);

    const reader = await required(database, 'database').connectAs('app_system');
    try {
      const { rows } = await reader.query<{ session_sealed: Buffer; version: number }>(
        `SELECT session_sealed, version FROM social_connection WHERE id = $1`,
        [connectionId],
      );
      expect(rows).toEqual([{ session_sealed: Buffer.from([2, 3]), version: 1 }]);
    } finally {
      await reader.end();
    }
  });

  it('records an acknowledgement with the user and the audit log and revokes it', async () => {
    const acceptedAt = new Date('2026-10-17T08:00:00Z');
    await unitOfWork().run(scopeA, async (store) => {
      await store.acknowledge({
        id: randomUUID(),
        workspaceId: wsA,
        userId: user,
        subject: 'x_browser',
        textVersion: '2026-10-17',
        textHash: 'a'.repeat(64),
        locale: 'de',
        ipAddress: '203.0.113.7',
        acceptedAt,
      });
      await store.audit.record({
        organizationId: orgA,
        workspaceId: wsA,
        action: 'x_browser.enable',
        targetType: 'Workspace',
        targetId: wsA,
        metadata: { textVersion: '2026-10-17', locale: 'de' },
      });
    });
    await expect(
      unitOfWork().run(scopeA, (store) => store.acknowledgement(wsA, 'x_browser')),
    ).resolves.toMatchObject({
      userId: user,
      userName: 'Olga Owner',
      textVersion: '2026-10-17',
      locale: 'de',
      acceptedAt,
    });
    await expect(
      unitOfWork().run(scopeB, (store) => store.acknowledgement(wsB, 'x_browser')),
    ).resolves.toBeNull();

    const owner = await required(database, 'database').connectAs('app_system');
    try {
      const { rows } = await owner.query<{ action: string; ip_address: string; actor_user_id: string }>(
        `SELECT action, ip_address, actor_user_id FROM audit_log WHERE workspace_id = $1`,
        [wsA],
      );
      expect(rows).toEqual([{ action: 'x_browser.enable', ip_address: '203.0.113.7', actor_user_id: user }]);
    } finally {
      await owner.end();
    }

    await expect(
      unitOfWork().run(scopeA, (store) => store.revoke(wsA, 'x_browser', new Date('2026-10-18T08:00:00Z'))),
    ).resolves.toBe(1);
    await expect(
      unitOfWork().run(scopeA, (store) => store.acknowledgement(wsA, 'x_browser')),
    ).resolves.toBeNull();
    await expect(
      unitOfWork().run(scopeA, (store) => store.revoke(wsA, 'x_browser', new Date('2026-10-18T09:00:00Z'))),
    ).resolves.toBe(0);
  });
});
