import { randomUUID } from 'node:crypto';

import type { ExportedOrganization, GdprRequest } from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  createSystemPrismaClient,
  EXPORT_TABLES,
  PrismaGdprRequestRunner,
  PrismaGdprUnitOfWork,
  PrismaOrganizationDataSource,
  type PrismaClient,
  type SystemPrismaClient,
} from '../src';
import { DEMO_USERS, seedDemoData } from '../src/seed/demo';
import { seedDemoAnalytics } from '../src/seed/demo-analytics';
import { createOrganization, fillOrganization } from './support/organization-fixtures';
import { inContext } from './support/sql-context';

// Guide step 8.1 on PostgreSQL: the export reads every table that names the organization or one
// of its workspaces, and nothing of another organization; secrets never leave the database, and
// the rows come as JSON with times in UTC. The owners create requests as app_user, one open per
// kind; the worker role "gdpr" runs them as app_system.

const NOW = new Date('2026-10-17T10:00:00Z');
const HOUR = 60 * 60 * 1000;

describe('data protection adapters on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let app: PrismaClient | undefined;
  let system: SystemPrismaClient | undefined;
  let fixtures: Client | undefined;
  let demo: { organizationId: string; workspaceId: string; ownerId: string } | undefined;
  const other = { organizationId: randomUUID(), workspaceId: randomUUID(), ownerId: randomUUID() };

  const clients = () => {
    if (!app || !system || !fixtures || !demo) {
      throw new Error('not started');
    }
    return { app, system, fixtures, demo };
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    const seeder = createPrismaClient(database.url('app_system'));
    try {
      const seeded = await seedDemoData(seeder, 'test-seed-password');
      await seedDemoAnalytics(seeder, seeded, NOW);
      const owner = seeded.userIds[DEMO_USERS.find((user) => user.role === 'OWNER')?.email ?? ''];
      if (!owner) {
        throw new Error('The demo seed has no users.');
      }
      demo = { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId, ownerId: owner };
    } finally {
      await seeder.$disconnect();
    }
    fixtures = await database.connectAs('app_system');
    await createOrganization(fixtures, other, { name: 'Other', slug: 'other', email: 'other@other.test' });
    await fillOrganization(fixtures, demo.organizationId, demo.workspaceId, demo.ownerId);
    await fillOrganization(fixtures, other.organizationId, other.workspaceId, other.ownerId);
    app = createPrismaClient(database.url('app_user'));
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await Promise.all([app?.$disconnect(), system?.$disconnect(), fixtures?.end()]);
    await database?.stop();
  });

  const collect = async (rows: AsyncIterable<string>): Promise<Record<string, unknown>[]> => {
    const result: Record<string, unknown>[] = [];
    for await (const row of rows) {
      result.push(JSON.parse(row) as Record<string, unknown>);
    }
    return result;
  };

  describe('the export', () => {
    it('covers every table that names an organization or a workspace', async () => {
      const { rows } = await clients().fixtures.query<{ table_name: string }>(
        `SELECT DISTINCT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name IN ('organization_id', 'workspace_id')`,
      );
      const exported = new Set(EXPORT_TABLES.map((table) => table.name));

      expect(rows.map((row) => row.table_name).filter((name) => !exported.has(name))).toEqual([]);
      expect(exported.has('organization')).toBe(true);
      expect(exported.has('users')).toBe(true);
    });

    it('leaves out every sealed column and every left-out column exists', async () => {
      const { rows } = await clients().fixtures.query<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      for (const table of EXPORT_TABLES) {
        const columns = rows.filter((row) => row.table_name === table.name);
        for (const column of table.omit ?? []) {
          expect(columns.map((row) => row.column_name)).toContain(column);
        }
        // Sealed tokens and sessions are the only binary columns; none may be exported.
        const binary = columns.filter((row) => row.data_type === 'bytea').map((row) => row.column_name);
        expect(binary.filter((column) => !(table.omit ?? []).includes(column))).toEqual([]);
      }
    });

    it('reads the rows of the organization only, without secrets, as JSON in UTC', async () => {
      const { system: client, demo: org } = clients();
      const source = new PrismaOrganizationDataSource(client, 7);
      const organization = await source.organization(org.organizationId);
      expect(organization).toMatchObject({ id: org.organizationId, workspaces: [{ id: org.workspaceId }] });
      const foreign = await new PrismaOrganizationDataSource(client).organization(other.organizationId);

      const counts: Record<string, number> = {};
      for (const table of source.tables()) {
        const rows = await collect(source.rows(table, organization as ExportedOrganization));
        const otherRows = await collect(source.rows(table, foreign as ExportedOrganization));
        counts[table] = rows.length;
        const ids = new Set(rows.map((row) => JSON.stringify(row)));
        // Pages of seven rows end and start right: no row twice, none of the other organization.
        expect(ids.size, table).toBe(rows.length);
        for (const row of otherRows) {
          expect(ids.has(JSON.stringify(row)), table).toBe(false);
        }
        for (const row of rows) {
          for (const column of EXPORT_TABLES.find((entry) => entry.name === table)?.omit ?? []) {
            expect(row, table).not.toHaveProperty(column);
          }
          for (const [key, value] of Object.entries(row)) {
            if (
              typeof value === 'string' &&
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) &&
              key.endsWith('_at')
            ) {
              expect(value, `${table}.${key}`).toMatch(/\+00:00$/);
            }
          }
        }
      }

      // Every exported table holds rows of the demo organization, as many as a plain count finds.
      expect(Object.entries(counts).filter(([, count]) => count === 0)).toEqual([]);
      const { rows: columns } = await clients().fixtures.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name IN ('organization_id', 'workspace_id')`,
      );
      for (const table of source.tables().filter((name) => name !== 'organization' && name !== 'users')) {
        const tenantColumns = columns.filter((row) => row.table_name === table).map((row) => row.column_name);
        const values: unknown[] = [];
        const conditions: string[] = [];
        if (tenantColumns.includes('organization_id')) {
          values.push(org.organizationId);
          conditions.push(`organization_id = $${String(values.length)}`);
        }
        if (tenantColumns.includes('workspace_id')) {
          values.push([org.workspaceId]);
          conditions.push(`workspace_id = ANY($${String(values.length)}::uuid[])`);
        }
        const { rows: counted } = await clients().fixtures.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM "${table}" WHERE ${conditions.join(' OR ')}`,
          values,
        );
        expect(counts[table], table).toBe(counted[0]?.count);
      }
      const users = await collect(source.rows('users', organization as ExportedOrganization));
      expect(users.map((user) => user['email'])).not.toContain('other@other.test');
      expect(users[0]).not.toHaveProperty('is_platform_admin');
      const { rows: memberCount } = await clients().fixtures.query<{ count: string }>(
        `SELECT count(*) FROM membership WHERE organization_id = $1`,
        [org.organizationId],
      );
      expect(users).toHaveLength(Number(memberCount[0]?.count));
      // Large numbers keep every digit.
      const [usage] = await collect(source.rows('usage_record', organization as ExportedOrganization));
      expect(JSON.stringify(usage)).toBeDefined();
      const raw: string[] = [];
      for await (const row of source.rows('usage_record', organization as ExportedOrganization)) {
        raw.push(row);
      }
      expect(raw.join('')).toContain('"quantity":9007199254740993');
    });

    it('pages the composite keys of the daily analytics like a single page does', async () => {
      const { system: client, demo: org } = clients();
      const organization = (await new PrismaOrganizationDataSource(client).organization(
        org.organizationId,
      )) as ExportedOrganization;

      const small = await collect(
        new PrismaOrganizationDataSource(client, 3).rows('analytics_daily', organization),
      );
      const large = await collect(
        new PrismaOrganizationDataSource(client, 10_000).rows('analytics_daily', organization),
      );

      expect(small.length).toBeGreaterThan(10);
      expect(small).toEqual(large);
    });

    it('lists the originals of the media library that passed the checks', async () => {
      const { system: client, fixtures: sql, demo: org } = clients();
      const source = new PrismaOrganizationDataSource(client, 1);
      const organization = (await source.organization(org.organizationId)) as ExportedOrganization;
      const unchecked = randomUUID();
      await sql.query(
        `INSERT INTO media_asset (id, workspace_id, status, file_name, declared_mime_type, declared_size, storage_key,
                                  updated_at)
         VALUES ($1, $2, 'PENDING_UPLOAD', 'unchecked.jpg', 'image/jpeg', 10, $3, now())`,
        [unchecked, org.workspaceId, `ws/${org.workspaceId}/assets/${unchecked}/original`],
      );

      const media = [];
      for await (const file of source.media(organization)) {
        media.push(file);
      }

      expect(media).toContainEqual(
        expect.objectContaining({
          workspaceSlug: organization.workspaces[0]?.slug,
          fileName: 'team photo.jpg',
          mimeType: 'image/jpeg',
        }),
      );
      expect(media.map((file) => file.assetId)).not.toContain(unchecked);
      expect(media.every((file) => file.storageKey.startsWith(`ws/${org.workspaceId}/`))).toBe(true);
      await sql.query(`DELETE FROM media_asset WHERE id = $1`, [unchecked]);
    });
  });

  describe('the requests', () => {
    const request = (organizationId: string, overrides: Partial<GdprRequest> = {}): GdprRequest => ({
      id: randomUUID(),
      organizationId,
      kind: 'EXPORT',
      status: 'PENDING',
      requestedById: null,
      runAfter: NOW,
      startedAt: null,
      completedAt: null,
      objectKey: null,
      expiresAt: null,
      details: {},
      createdAt: NOW,
      ...overrides,
    });

    it('keeps one open export per organization without aborting the transaction', async () => {
      const { app: client, demo: org } = clients();
      const unitOfWork = new PrismaGdprUnitOfWork(client);
      const scope = { userId: org.ownerId, organizationId: org.organizationId };
      const first = request(org.organizationId, { requestedById: org.ownerId });

      const result = await unitOfWork.run(scope, async (store) => {
        const created = await store.requests.create(first);
        const second = await store.requests.create(request(org.organizationId));
        // The transaction still works after the conflict.
        const open = await store.requests.findOpen(org.organizationId, 'EXPORT');
        await store.audit.record({
          organizationId: org.organizationId,
          action: 'gdpr.export_requested',
          targetType: 'GdprRequest',
          targetId: first.id,
        });
        return { created, second, open };
      });

      expect(result).toMatchObject({
        created: true,
        second: false,
        open: { id: first.id, status: 'PENDING' },
      });
      await expect(
        unitOfWork.run(scope, (store) => store.requests.find(org.organizationId, first.id)),
      ).resolves.toMatchObject({ id: first.id, requestedById: org.ownerId });
      await expect(
        unitOfWork.run(scope, (store) => store.requests.listRecent(org.organizationId, 'EXPORT', 10)),
      ).resolves.toContainEqual(expect.objectContaining({ id: first.id }));

      // The worker runs it; then a new one may wait.
      const runner = new PrismaGdprRequestRunner(clients().system);
      await expect(runner.claim(first.id, new Date(NOW.getTime() + 1000))).resolves.toMatchObject({
        status: 'RUNNING',
      });
      await expect(
        runner.complete(first.id, NOW, {
          objectKey: `exports/${org.organizationId}/${first.id}.zip`,
          expiresAt: new Date(NOW.getTime() + 24 * HOUR),
          details: { rows: 3 },
        }),
      ).resolves.toBe(true);
      await expect(
        unitOfWork.run(scope, (store) => store.requests.create(request(org.organizationId))),
      ).resolves.toBe(true);
    });

    it('lets owners read and add requests of their organization only, and change none but a waiting erasure', async () => {
      const { fixtures: client, demo: org } = clients();
      const appClient = await database?.connectAs('app_user');
      if (!appClient) {
        throw new Error('not started');
      }
      try {
        const visible = await inContext(appClient, { organizationId: other.organizationId }, async () => {
          const { rows } = await appClient.query<{ organization_id: string }>(
            'SELECT organization_id FROM gdpr_request',
          );
          return rows.map((row) => row.organization_id);
        });
        expect(new Set(visible)).toEqual(new Set([other.organizationId]));

        await expect(
          inContext(appClient, { organizationId: other.organizationId }, () =>
            appClient.query(
              `INSERT INTO gdpr_request (id, organization_id, kind, status, updated_at)
               VALUES ($1, $2, 'EXPORT', 'PENDING', now())`,
              [randomUUID(), org.organizationId],
            ),
          ),
        ).rejects.toThrow(/row-level security/);
        await expect(
          inContext(appClient, { organizationId: other.organizationId }, () =>
            appClient.query(
              `INSERT INTO gdpr_request (id, organization_id, kind, status, object_key, updated_at)
               VALUES ($1, $2, 'ERASURE', 'COMPLETED', 'exports/x', now())`,
              [randomUUID(), other.organizationId],
            ),
          ),
        ).rejects.toThrow(/row-level security/);
        // Only the status of a waiting erasure may change, to CANCELED (guide step 8.2); there is none.
        await expect(
          inContext(appClient, { organizationId: other.organizationId }, () =>
            appClient.query(`UPDATE gdpr_request SET status = 'CANCELED'`),
          ),
        ).resolves.toMatchObject({ rowCount: 0 });
        await expect(
          inContext(appClient, { organizationId: other.organizationId }, () =>
            appClient.query(`UPDATE gdpr_request SET object_key = 'exports/x'`),
          ),
        ).rejects.toThrow(/permission denied/);
        await expect(
          inContext(appClient, { organizationId: other.organizationId }, () =>
            appClient.query(`DELETE FROM gdpr_request`),
          ),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await appClient.end();
      }
      const { rows } = await client.query(`SELECT count(*)::int AS count FROM gdpr_request`);
      expect(rows[0]).toBeDefined();
    });

    it('claims due requests only, fails, gives up hanging ones and expires archives', async () => {
      const { system: client, fixtures: sql } = clients();
      const runner = new PrismaGdprRequestRunner(client);
      const orgId = other.organizationId;
      const later = randomUUID();
      const hanging = randomUUID();
      const expired = randomUUID();
      const failing = randomUUID();
      await sql.query(
        `INSERT INTO gdpr_request (id, organization_id, kind, status, run_after, created_at, updated_at)
         VALUES ($1, $2, 'ERASURE', 'PENDING', $3, $4, now()),
                ($5, $2, 'EXPORT', 'RUNNING', $4, $6, now())`,
        [later, orgId, new Date(NOW.getTime() + HOUR), NOW, hanging, new Date(NOW.getTime() - 13 * HOUR)],
      );
      await sql.query(
        `INSERT INTO gdpr_request (id, organization_id, kind, status, object_key, expires_at, updated_at)
         VALUES ($1, $2, 'EXPORT', 'COMPLETED', 'exports/other/old.zip', $3, now())`,
        [expired, orgId, new Date(NOW.getTime() - 1)],
      );

      await expect(runner.claim(later, NOW)).resolves.toBeNull();
      await expect(runner.claim(randomUUID(), NOW)).resolves.toBeNull();

      await expect(runner.failStale('EXPORT', new Date(NOW.getTime() - 12 * HOUR), NOW)).resolves.toBe(1);
      const { rows: stale } = await sql.query<{ status: string; details: unknown }>(
        `SELECT status, details FROM gdpr_request WHERE id = $1`,
        [hanging],
      );
      expect(stale[0]).toEqual({ status: 'FAILED', details: { failure: 'TIMEOUT' } });
      await expect(runner.complete(hanging, NOW, { details: {} })).resolves.toBe(false);

      await sql.query(
        `INSERT INTO gdpr_request (id, organization_id, kind, status, details, updated_at)
         VALUES ($1, $2, 'EXPORT', 'RUNNING', '{"rows": 1}', now())`,
        [failing, orgId],
      );
      await runner.fail(failing, NOW, { failure: 'INTERNAL' });
      const { rows: failed } = await sql.query<{ status: string; details: unknown; completed_at: Date }>(
        `SELECT status, details, completed_at FROM gdpr_request WHERE id = $1`,
        [failing],
      );
      expect(failed[0]).toEqual({
        status: 'FAILED',
        details: { rows: 1, failure: 'INTERNAL' },
        completed_at: NOW,
      });

      await expect(runner.expiredExports(NOW, 10)).resolves.toContainEqual({
        id: expired,
        objectKey: 'exports/other/old.zip',
      });
      await runner.clearExport(expired);
      await expect(runner.expiredExports(NOW, 10)).resolves.not.toContainEqual(
        expect.objectContaining({ id: expired }),
      );
    });
  });
});
