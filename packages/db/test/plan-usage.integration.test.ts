import { randomUUID } from 'node:crypto';

import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSystemPrismaClient, PrismaPlanUsage, type SystemPrismaClient } from '../src';

// Guide step 7.4 on PostgreSQL: what an organization uses of its plan across all its workspaces,
// and nothing of another organization.

const org = randomUUID();
const other = randomUUID();
const [first, second, foreign] = [randomUUID(), randomUUID(), randomUUID()];

describe('plan usage on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let system: SystemPrismaClient | undefined;
  const scheduled = randomUUID();

  const usage = () => {
    if (!system) {
      throw new Error('not started');
    }
    return new PrismaPlanUsage(system);
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    const fixtures = await database.connectAs('app_system');
    const query = (sql: string, values: unknown[] = []) => fixtures.query(sql, values);
    try {
      await query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Acme', now()), ($2, 'Other', now())`,
        [org, other],
      );
      await query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $4, 'usage-first', 'First', 'UTC', 'de', now()),
                ($2, $4, 'usage-second', 'Second', 'UTC', 'de', now()),
                ($3, $5, 'usage-foreign', 'Foreign', 'UTC', 'de', now())`,
        [first, second, foreign, org, other],
      );
      for (const [index, workspace] of [first, second, foreign].entries()) {
        const connection = randomUUID();
        await query(
          `INSERT INTO social_connection (id, workspace_id, platform, method, status, external_user_id, display_name,
                                          access_token_sealed, updated_at)
           VALUES ($1, $2, 'X', 'MOCK', 'ACTIVE', $3, 'Mira', '\\x01', now())`,
          [connection, workspace, `user-${String(index)}`],
        );
        // Two accounts in each workspace; the second one of the first workspace is disconnected.
        await query(
          `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name,
                                       disconnected_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'X', 'PROFILE', 'a', 'A', NULL, now()),
                  (gen_random_uuid(), $1, $2, 'X', 'PROFILE', 'b', 'B', $3::timestamptz, now())`,
          [workspace, connection, index === 0 ? '2026-10-01T00:00:00Z' : null],
        );
        const post = randomUUID();
        await query(
          `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
          [post, workspace],
        );
        const variants = [
          [index === 0 ? scheduled : randomUUID(), 'SCHEDULED', '2026-10-20T08:00:00Z', null],
          [randomUUID(), 'PUBLISHED', '2026-09-30T23:00:00Z', '2026-10-01T00:10:00Z'],
          [randomUUID(), 'FAILED', '2026-10-05T08:00:00Z', null],
          [randomUUID(), 'DRAFT', null, null],
          [randomUUID(), 'QUEUED', '2026-11-01T00:00:00Z', null],
        ] as const;
        for (const [key, [id, status, scheduledAt, publishedAt]] of variants.entries()) {
          await query(
            `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, status, scheduled_at,
                                       published_at, updated_at)
             VALUES ($1, $2, $3, 'X', $4, $5, $6, $7, now())`,
            [id, workspace, post, `t${String(key)}`, status, scheduledAt, publishedAt],
          );
        }
        await query(
          `INSERT INTO media_asset (id, workspace_id, status, file_name, declared_mime_type, declared_size, size_bytes,
                                    storage_key, deleted_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'READY', 'a.png', 'image/png', 900, 1000, $2, NULL, now()),
                  (gen_random_uuid(), $1, 'PENDING_UPLOAD', 'b.png', 'image/png', 500, NULL, $3, NULL, now()),
                  (gen_random_uuid(), $1, 'REJECTED', 'c.png', 'image/png', 700, 700, $4, NULL, now()),
                  (gen_random_uuid(), $1, 'READY', 'd.png', 'image/png', 300, 300, $5, now(), now())`,
          [workspace, ...['a', 'b', 'c', 'd'].map((name) => `ws/${workspace}/${name}`)],
        );
      }
      await query(
        `INSERT INTO api_cost_record (id, organization_id, platform, operation, cost_micros, source_type, source_id,
                                      created_at)
         VALUES (gen_random_uuid(), $1, 'X', 'x.post_create', 15000, 'publish_attempt', gen_random_uuid(), '2026-10-02T00:00:00Z'),
                (gen_random_uuid(), $1, 'X', 'x.post_read', 5000, 'metrics_poll', gen_random_uuid(), '2026-10-31T23:59:59Z'),
                (gen_random_uuid(), $1, 'X', 'x.post_create', 15000, 'publish_attempt', gen_random_uuid(), '2026-09-30T23:59:59Z'),
                (gen_random_uuid(), $1, 'LINKEDIN', 'li.post', 99, 'publish_attempt', gen_random_uuid(), '2026-10-02T00:00:00Z'),
                (gen_random_uuid(), $2, 'X', 'x.post_create', 15000, 'publish_attempt', gen_random_uuid(), '2026-10-02T00:00:00Z')`,
        [org, other],
      );
    } finally {
      await fixtures.end();
    }
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await system?.$disconnect();
    await database?.stop();
  });

  it('counts the connected accounts of every workspace of the organization', async () => {
    await expect(usage().socialAccounts(org)).resolves.toBe(3);
    await expect(usage().socialAccounts(other)).resolves.toBe(2);
  });

  it('counts the posts that go out in the month, without the one being planned', async () => {
    const october = new Date('2026-10-15T12:00:00Z');
    // Per workspace: the scheduled one and the one published on the first; not the failed one,
    // the draft or the one of November.
    await expect(usage().postsInMonth(org, october, null)).resolves.toBe(4);
    await expect(usage().postsInMonth(org, october, scheduled)).resolves.toBe(3);
    await expect(usage().postsInMonth(org, new Date('2026-11-30T23:59:59Z'), null)).resolves.toBe(2);
    await expect(usage().postsInMonth(org, new Date('2026-09-01T00:00:00Z'), null)).resolves.toBe(0);
  });

  it('sums the originals of the media libraries and the X costs of the month', async () => {
    // 1000 measured and 500 announced per workspace; rejected and deleted ones are gone.
    await expect(usage().storageBytes(org)).resolves.toBe(3_000);
    await expect(usage().xApiSpendMicros(org, new Date('2026-10-15T00:00:00Z'))).resolves.toBe(20_000);
    await expect(usage().xApiSpendMicros(org, new Date('2026-09-15T00:00:00Z'))).resolves.toBe(15_000);
  });
});
