import { randomUUID } from 'node:crypto';

import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  createSystemPrismaClient,
  createTenantClient,
  MissingTenantContextError,
  runInSystemScope,
  SystemScope,
  SystemScopeViolationError,
  TENANT_FILTERS,
  TenantFilterMissingError,
  withTenantTx,
  type PrismaClient,
  type SystemPrismaClient,
  type TenantContext,
  type TenantPrismaClient,
} from '../src';

const orgA = randomUUID();
const orgB = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();

describe('tenant client, tenant transactions and system client', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;
  let tenant: TenantPrismaClient | undefined;
  let unchecked: TenantPrismaClient | undefined;
  let system: SystemPrismaClient | undefined;
  let current: TenantContext | undefined;

  const required = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) {
      throw new Error(`${name} is not set up`);
    }
    return value;
  };
  const asOrg = (organizationId: string, userId: string): TenantContext => ({ userId, organizationId });

  beforeAll(async () => {
    database = await startTestDatabase();
    const fixtures = createPrismaClient(database.url('app_system'));
    try {
      for (const [id, email] of [
        [alice, 'alice@example.test'],
        [bob, 'bob@example.test'],
      ] as const) {
        await fixtures.user.create({ data: { id, email, name: email } });
      }
      for (const [organizationId, workspaceId, userId, slug] of [
        [orgA, workspaceA, alice, 'ws-a'],
        [orgB, workspaceB, bob, 'ws-b'],
      ] as const) {
        await fixtures.organization.create({ data: { id: organizationId, name: slug } });
        await fixtures.workspace.create({
          data: {
            id: workspaceId,
            organizationId,
            slug,
            name: slug,
            timezone: 'UTC',
            contentLanguage: 'en',
            settings: { create: {} },
          },
        });
        await fixtures.membership.create({ data: { organizationId, userId, role: 'OWNER' } });
      }
    } finally {
      await fixtures.$disconnect();
    }

    base = createPrismaClient(database.url('app_user'));
    tenant = createTenantClient(base, () => current, { assertTenantFilter: true });
    unchecked = createTenantClient(base, () => current);
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await system?.$disconnect();
    await database?.stop();
  });

  describe('tenant client', () => {
    it('returns only the data of the organization in the context', async () => {
      const client = required(tenant, 'tenant client');
      current = asOrg(orgA, alice);
      const inA = await client.workspace.findMany({ where: { organizationId: orgA } });
      current = asOrg(orgB, bob);
      const inB = await client.workspace.findMany({ where: { organizationId: orgB } });

      expect(inA.map((workspace) => workspace.id)).toEqual([workspaceA]);
      expect(inB.map((workspace) => workspace.id)).toEqual([workspaceB]);
    });

    it('lets row-level security hide foreign rows even without an explicit filter', async () => {
      current = asOrg(orgA, alice);
      const rows = await required(unchecked, 'unchecked client').membership.findMany();
      expect(rows.map((membership) => membership.organizationId)).toEqual([orgA]);
    });

    it('rejects a query without the tenant filter in development and tests', async () => {
      current = asOrg(orgA, alice);
      await expect(required(tenant, 'tenant client').membership.findMany()).rejects.toThrow(
        TenantFilterMissingError,
      );
      await expect(
        required(tenant, 'tenant client').workspace.findMany({ where: { organizationId: orgB } }),
      ).rejects.toThrow(TenantFilterMissingError);
    });

    it('cannot write into another organization', async () => {
      current = asOrg(orgA, alice);
      await expect(
        required(unchecked, 'unchecked client').workspace.update({
          where: { id: workspaceB },
          data: { name: 'taken over' },
        }),
      ).rejects.toThrow();
    });

    it('throws without context instead of running unfiltered', async () => {
      current = undefined;
      await expect(
        required(tenant, 'tenant client').workspace.findMany({ where: { organizationId: orgA } }),
      ).rejects.toThrow(MissingTenantContextError);
    });

    it('serves the user-scoped reads with only the user in the context', async () => {
      current = { userId: bob };
      const workspaces = await required(tenant, 'tenant client').workspace.findMany({
        where: { slug: { in: ['ws-a', 'ws-b'] } },
      });
      expect(workspaces.map((workspace) => workspace.id)).toEqual([workspaceB]);
    });
  });

  describe('withTenantTx', () => {
    it('sets the context once for an atomic unit of work', async () => {
      const client = required(base, 'base client');
      const created = await withTenantTx(client, asOrg(orgA, alice), async (tx) => {
        const workspace = await tx.workspace.create({
          data: {
            organizationId: orgA,
            slug: 'ws-a-2',
            name: 'Second',
            timezone: 'UTC',
            contentLanguage: 'en',
          },
        });
        const [setting] = await tx.$queryRaw<{ organization_id: string }[]>`
          SELECT current_setting('app.organization_id', true) AS organization_id`;
        return { workspace, setting };
      });

      expect(created.setting?.organization_id).toBe(orgA);
      expect(created.workspace.organizationId).toBe(orgA);
    });

    it('rolls the whole unit back when a statement fails', async () => {
      const client = required(base, 'base client');
      await expect(
        withTenantTx(client, asOrg(orgA, alice), async (tx) => {
          await tx.workspace.create({
            data: {
              organizationId: orgA,
              slug: 'ws-a-rollback',
              name: 'Rollback',
              timezone: 'UTC',
              contentLanguage: 'en',
            },
          });
          // Violates the policy: the membership belongs to another organization.
          await tx.membership.create({ data: { organizationId: orgB, userId: alice, role: 'VIEWER' } });
        }),
      ).rejects.toThrow();

      const leftovers = await withTenantTx(client, asOrg(orgA, alice), (tx) =>
        tx.workspace.count({ where: { organizationId: orgA, slug: 'ws-a-rollback' } }),
      );
      expect(leftovers).toBe(0);
    });
  });

  describe('system client', () => {
    it('refuses every operation outside a system scope', async () => {
      await expect(required(system, 'system client').workspace.count()).rejects.toThrow(
        SystemScopeViolationError,
      );
    });

    it('scans across tenants inside a method marked with @SystemScope()', async () => {
      const client = required(system, 'system client');
      class ScanRepository {
        countAllWorkspaces(): Promise<number> {
          return client.workspace.count({ where: { slug: { in: ['ws-a', 'ws-b'] } } });
        }
      }
      const descriptor = Object.getOwnPropertyDescriptor(ScanRepository.prototype, 'countAllWorkspaces');
      if (!descriptor) {
        throw new Error('method not found');
      }
      SystemScope()(ScanRepository.prototype, 'countAllWorkspaces', descriptor);
      Object.defineProperty(ScanRepository.prototype, 'countAllWorkspaces', descriptor);

      await expect(new ScanRepository().countAllWorkspaces()).resolves.toBe(2);
      await expect(runInSystemScope(() => client.organization.count())).resolves.toBeGreaterThanOrEqual(2);
    });
  });

  it('knows the tenant filter of every table with a tenant column', async () => {
    const owner = await required(database, 'database').connectAs('app_migrator');
    try {
      const { rows } = await owner.query<{ table_name: string }>(
        `SELECT DISTINCT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name IN ('organization_id', 'workspace_id')
          ORDER BY table_name`,
      );
      // feature_flag is scoped by its policies alone: global and organization rows have no workspace.
      const covered = new Set(
        Object.keys(TENANT_FILTERS).map((model) => model.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase()),
      );
      const uncovered = rows.map((row) => row.table_name).filter((table) => !covered.has(table));
      expect(uncovered).toEqual(['feature_flag']);
    } finally {
      await owner.end();
    }
  });
});
