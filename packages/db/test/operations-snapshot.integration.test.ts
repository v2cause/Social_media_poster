import { randomUUID } from 'node:crypto';

import { startTestDatabase, type TestDatabase } from '@smp/testing';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSystemPrismaClient,
  readOperationsCounts,
  readStorageBytes,
  type SystemPrismaClient,
} from '../src';
import { createOrganization, type TestOrganization } from './support/organization-fixtures';

// Guide step 8.7 on PostgreSQL: the counts behind the alerts. Stuck are QUEUED variants whose job
// did not start within ten minutes; the AI and the spend on X count the last 24 hours; the media
// library counts what is neither deleted nor rejected; the archiver is off in a test database.

const NOW = new Date('2026-10-19T04:00:00Z');
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

describe('the operations counts on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let system: SystemPrismaClient | undefined;
  let sql: Client | undefined;
  const tenant: TestOrganization = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
  };

  const clients = () => {
    if (!system || !sql) {
      throw new Error('not started');
    }
    return { system, sql };
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    sql = await database.connectAs('app_system');
    await createOrganization(sql, tenant, { name: 'Ops', slug: 'ops', email: 'ops@ops.test' });
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await Promise.all([system?.$disconnect(), sql?.end()]);
    await database?.stop();
  });

  it('counts stuck variants, connections to log in again, kill switches, AI, X and the archiver', async () => {
    const { sql: client } = clients();
    const ws = tenant.workspaceId;
    const post = randomUUID();
    await client.query(
      `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
      [post, ws],
    );
    const variant = async (status: string, queuedAt: Date | null) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, status, queued_at, updated_at)
         VALUES ($1, $2, $3, 'LINKEDIN', $4, $5::"VariantStatus", $6, now())`,
        [id, ws, post, `linkedin:${id}`, status, queuedAt],
      );
    };
    await variant('QUEUED', minutesAgo(60));
    await variant('QUEUED', minutesAgo(11));
    await variant('QUEUED', minutesAgo(2));
    await variant('SCHEDULED', null);

    const connection = async (platform: string, status: string) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                        access_token_sealed, status, updated_at)
         VALUES ($1, $2, $3::"Platform", 'API', $4, 'Ops', '\\x01'::bytea, $5::"ConnectionStatus", now())`,
        [id, ws, platform, `ext-${id}`, status],
      );
    };
    await connection('LINKEDIN', 'NEEDS_REAUTH');
    await connection('X', 'NEEDS_REAUTH');
    await connection('X', 'NEEDS_REAUTH');
    await connection('FACEBOOK', 'ACTIVE');

    await client.query(
      `INSERT INTO feature_flag (id, key, enabled, updated_at) VALUES ($1, 'x_browser_automation', false, now())`,
      [randomUUID()],
    );
    await client.query(
      `INSERT INTO feature_flag (id, key, workspace_id, enabled, updated_at)
       VALUES ($1, 'x_browser_automation', $2, true, now())`,
      [randomUUID(), ws],
    );

    const generation = async (outcome: string, createdAt: Date, cost: number) => {
      await client.query(
        `INSERT INTO ai_generation (id, workspace_id, task, prompt_version, provider, model_requested, effort,
                                    outcome, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                    cost_micros, created_at)
         VALUES ($1, $2, 'GENERATE', 'v1', 'mock', 'mock-model', 'low', $3::"AiOutcome", 100, 50, 80, 20, $4, $5)`,
        [randomUUID(), ws, outcome, cost, createdAt],
      );
    };
    await generation('OK', minutesAgo(30), 1_500);
    await generation('REFUSED', minutesAgo(23 * 60), 500);
    await generation('OK', minutesAgo(25 * 60), 9_000);

    const cost = async (platform: string, createdAt: Date, micros: number) => {
      await client.query(
        `INSERT INTO api_cost_record (id, organization_id, workspace_id, platform, operation, cost_micros,
                                      source_type, source_id, created_at)
         VALUES ($1, $2, $3, $4::"Platform", 'x.post_create', $5, 'publish_attempt', $6, $7)`,
        [randomUUID(), tenant.organizationId, ws, platform, micros, randomUUID(), createdAt],
      );
    };
    await cost('X', minutesAgo(10), 15_000);
    await cost('X', minutesAgo(25 * 60), 15_000);
    await cost('LINKEDIN', minutesAgo(10), 7_000);

    await expect(readOperationsCounts(clients().system, NOW)).resolves.toEqual({
      stuckQueued: 2,
      needsReauth: [
        { platform: 'LINKEDIN', connections: 1 },
        { platform: 'X', connections: 2 },
      ],
      globalFlags: [{ key: 'x_browser_automation', enabled: false }],
      ai24h: {
        generations: 2,
        refusals: 1,
        costMicros: 2_000,
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 160,
        cacheWriteTokens: 40,
      },
      xSpend24hMicros: 15_000,
      archiver: {
        archiveMode: false,
        archivedCount: 0,
        failedCount: 0,
        lastArchivedAt: null,
        lastFailedAt: null,
      },
    });
  });

  it('adds up the media library without deleted and rejected files', async () => {
    const { sql: client } = clients();
    const asset = async (status: string, declared: number, measured: number | null, deleted: boolean) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO media_asset (id, workspace_id, status, file_name, declared_mime_type, declared_size,
                                  size_bytes, storage_key, deleted_at, updated_at)
         VALUES ($1, $2, $3::"MediaStatus", 'photo.jpg', 'image/jpeg', $4, $5, $6, $7, now())`,
        [
          id,
          tenant.workspaceId,
          status,
          declared,
          measured,
          `ws/${tenant.workspaceId}/assets/${id}/original`,
          deleted ? NOW : null,
        ],
      );
    };
    await asset('READY', 1_200, 1_000, false);
    await asset('PENDING_UPLOAD', 500, null, false);
    await asset('READY', 9_000, 9_000, true);
    await asset('REJECTED', 7_000, 7_000, false);

    await expect(readStorageBytes(clients().system)).resolves.toBe(1_500);
  });
});
