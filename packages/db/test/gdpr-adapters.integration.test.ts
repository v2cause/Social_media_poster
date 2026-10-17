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
import { inContext } from './support/sql-context';

// Guide step 8.1 on PostgreSQL: the export reads every table that names the organization or one
// of its workspaces, and nothing of another organization; secrets never leave the database, and
// the rows come as JSON with times in UTC. The owners create requests as app_user, one open per
// kind; the worker role "gdpr" runs them as app_system.

const NOW = new Date('2026-10-17T10:00:00Z');
const HOUR = 60 * 60 * 1000;

/** Rows of the tables the demo seed leaves empty, for one organization and workspace. */
async function fill(
  client: Client,
  organizationId: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const connection = randomUUID();
  await client.query(
    `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                    access_token_sealed, refresh_token_sealed, session_sealed, updated_at)
     VALUES ($1, $2, 'X', 'API', $3, 'Export Test', '\\x0101'::bytea, '\\x0202'::bytea, '\\x0303'::bytea, now())`,
    [connection, workspaceId, `ext-${connection}`],
  );
  await client.query(
    `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name,
                                 access_token_sealed, updated_at)
     VALUES ($1, $2, $3, 'X', 'PROFILE', $4, 'Export Test', '\\x0404'::bytea, now())`,
    [randomUUID(), workspaceId, connection, `acc-${connection}`],
  );
  await client.query(
    `INSERT INTO invitation (id, organization_id, email, role, token_hash, invited_by_id, expires_at)
     VALUES ($1, $2, $3, 'EDITOR', $4, $5, now() + interval '7 days')`,
    [randomUUID(), organizationId, `invited-${organizationId}@example.test`, `hash-${randomUUID()}`, userId],
  );
  await client.query(
    `INSERT INTO notification (id, user_id, organization_id, workspace_id, type)
     VALUES ($1, $2, $3, $4, 'publish-failed')`,
    [randomUUID(), userId, organizationId, workspaceId],
  );
  await client.query(
    `INSERT INTO feature_flag (id, key, workspace_id, enabled, updated_at)
     VALUES ($1, 'x_browser_enabled', $2, true, now())`,
    [randomUUID(), workspaceId],
  );
  await client.query(
    `INSERT INTO usage_record (id, organization_id, workspace_id, meter, source_type, source_id, quantity, period_start)
     VALUES ($1, $2, $3, 'ai_credits_micros', 'AiGeneration', $4, 9007199254740993, '2026-10-01')`,
    [randomUUID(), organizationId, workspaceId, randomUUID()],
  );
  await client.query(
    `INSERT INTO api_cost_record (id, organization_id, workspace_id, platform, operation, cost_micros, source_type, source_id)
     VALUES ($1, $2, $3, 'X', 'post.create', 15000, 'PublishAttempt', $4)`,
    [randomUUID(), organizationId, workspaceId, randomUUID()],
  );
  const asset = randomUUID();
  await client.query(
    `INSERT INTO media_asset (id, workspace_id, file_name, declared_mime_type, declared_size, storage_key, updated_at)
     VALUES ($1, $2, 'team photo.jpg', 'image/jpeg', 1234, $3, now())`,
    [asset, workspaceId, `ws/${workspaceId}/assets/${asset}/original`],
  );
  await client.query(
    `INSERT INTO media_rendition (id, workspace_id, asset_id, profile, crop_hash, storage_key, mime_type, width,
                                  height, size_bytes)
     VALUES ($1, $2, $3, 'x-landscape', 'crop', $4, 'image/jpeg', 1600, 900, 1000)`,
    [randomUUID(), workspaceId, asset, `ws/${workspaceId}/assets/${asset}/x-landscape.jpg`],
  );
  const post = randomUUID();
  const variant = randomUUID();
  await client.query(
    `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
    [post, workspaceId],
  );
  await client.query(
    `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, updated_at)
     VALUES ($1, $2, $3, 'X', $4, now())`,
    [variant, workspaceId, post, `x:${variant}`],
  );
  await client.query(
    `INSERT INTO post_media (id, workspace_id, variant_id, asset_id, position, updated_at)
     VALUES ($1, $2, $3, $4, 0, now())`,
    [randomUUID(), workspaceId, variant, asset],
  );
  await client.query(
    `INSERT INTO publish_attempt (id, workspace_id, variant_id, schedule_version, attempt_number, trigger, lease_owner)
     VALUES ($1, $2, $3, 1, 1, 'schedule', 'worker-1')`,
    [randomUUID(), workspaceId, variant],
  );
  const voice = randomUUID();
  await client.query(
    `INSERT INTO brand_voice (id, workspace_id, name, current_version_number, updated_at)
     VALUES ($1, $2, 'Voice', 1, now())`,
    [voice, workspaceId],
  );
  await client.query(
    `INSERT INTO brand_voice_version (id, workspace_id, brand_voice_id, version_number, content, content_hash)
     VALUES ($1, $2, $3, 1, '{"tone": "friendly"}', 'hash')`,
    [randomUUID(), workspaceId, voice],
  );
  await client.query(
    `INSERT INTO post_style (id, workspace_id, key, name, instructions, updated_at)
     VALUES ($1, $2, $3, 'Own style', 'Short sentences.', now())`,
    [randomUUID(), workspaceId, `own-${workspaceId}`],
  );
  await client.query(
    `INSERT INTO idea (id, workspace_id, title, updated_at) VALUES ($1, $2, 'An idea', now())`,
    [randomUUID(), workspaceId],
  );
  await client.query(
    `INSERT INTO ai_generation (id, workspace_id, task, prompt_version, provider, model_requested, effort, input, outcome)
     VALUES ($1, $2, 'GENERATE', 'v1', 'mock', 'mock-model', 'low', '{"topic": "launch"}', 'OK')`,
    [randomUUID(), workspaceId],
  );
  await client.query(
    `INSERT INTO membership_workspace (membership_id, workspace_id, organization_id)
     SELECT id, $2, organization_id FROM membership WHERE organization_id = $1 AND user_id = $3`,
    [organizationId, workspaceId, userId],
  );
  await client.query(
    `INSERT INTO usage_counter (id, organization_id, meter, period_start, updated_at)
     VALUES ($1, $2, 'ai_credits_micros', '2026-10-01', now())`,
    [randomUUID(), organizationId],
  );
  await client.query(
    `INSERT INTO audit_log (id, organization_id, workspace_id, action, target_type)
     VALUES ($1, $2, $3, 'post.created', 'Post')`,
    [randomUUID(), organizationId, workspaceId],
  );
  await client.query(
    `INSERT INTO risk_acknowledgement (id, workspace_id, user_id, subject, text_version, text_hash, locale, accepted_at)
     VALUES ($1, $2, $3, 'x-browser', '1', 'text-hash', 'de', now())`,
    [randomUUID(), workspaceId, userId],
  );
  await client.query(
    `INSERT INTO outbox_event (id, workspace_id, type, payload) VALUES ($1, $2, 'variant.status', '{}')`,
    [randomUUID(), workspaceId],
  );
  await client.query(
    `INSERT INTO gdpr_request (id, organization_id, kind, status, requested_by_id, updated_at)
     VALUES ($1, $2, 'EXPORT', 'COMPLETED', $3, now())`,
    [randomUUID(), organizationId, userId],
  );
}

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
    await fixtures.query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Other', now())`, [
      other.organizationId,
    ]);
    await fixtures.query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'other', 'Other', 'Europe/Berlin', 'de', now())`,
      [other.workspaceId, other.organizationId],
    );
    await fixtures.query(`INSERT INTO workspace_settings (workspace_id, updated_at) VALUES ($1, now())`, [
      other.workspaceId,
    ]);
    await fixtures.query(
      `INSERT INTO users (id, email, name, email_verified, locale, updated_at)
       VALUES ($1, 'other@other.test', 'Otto Other', true, 'de', now())`,
      [other.ownerId],
    );
    await fixtures.query(
      `INSERT INTO membership (id, organization_id, user_id, role, updated_at) VALUES ($1, $2, $3, 'OWNER', now())`,
      [randomUUID(), other.organizationId, other.ownerId],
    );
    await fill(fixtures, demo.organizationId, demo.workspaceId, demo.ownerId);
    await fill(fixtures, other.organizationId, other.workspaceId, other.ownerId);
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

    it('lists the originals of the media library', async () => {
      const { system: client, demo: org } = clients();
      const source = new PrismaOrganizationDataSource(client, 1);
      const organization = (await source.organization(org.organizationId)) as ExportedOrganization;

      const media = [];
      for await (const file of source.media(organization)) {
        media.push(file);
      }

      expect(media).toContainEqual(
        expect.objectContaining({
          workspaceSlug: organization.workspaces[0]?.slug,
          fileName: 'team photo.jpg',
        }),
      );
      expect(media.every((file) => file.storageKey.startsWith(`ws/${org.workspaceId}/`))).toBe(true);
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

    it('lets owners read and add requests of their organization only, and never change them', async () => {
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
        await expect(
          inContext(appClient, { organizationId: other.organizationId }, () =>
            appClient.query(`UPDATE gdpr_request SET status = 'CANCELED'`),
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
