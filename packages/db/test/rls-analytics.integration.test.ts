import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import { findRlsViolations } from '../src';
import { inContext } from './support/sql-context';

// Guide step 5.1: the analytics tables are isolated per workspace, and the snapshots of the post
// metrics are append-only for app_user.

const f = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  a1: randomUUID(),
  b1: randomUUID(),
  accountA: randomUUID(),
  accountB: randomUUID(),
  variantA: randomUUID(),
  variantB: randomUUID(),
  snapshotA: randomUUID(),
  snapshotB: randomUUID(),
};

/** Each table with the column that names its rows in the checks. */
const TABLES = {
  metric_snapshot: 'id',
  post_metric_latest: 'variant_id',
  account_metric_snapshot: 'social_account_id',
  analytics_daily: 'social_account_id',
} as const;

describe('row-level security of the analytics tables', () => {
  let database: TestDatabase | undefined;
  let runtime: Client | undefined;

  const db = (): TestDatabase => {
    if (!database) {
      throw new Error('PostgreSQL test container is not running');
    }
    return database;
  };
  const app = (): Client => {
    if (!runtime) {
      throw new Error('app_user is not connected');
    }
    return runtime;
  };
  const inA = <T>(fn: () => Promise<T>): Promise<T> =>
    inContext(app(), { organizationId: f.orgA, workspaceId: f.a1 }, fn);
  const keysOf = async (table: keyof typeof TABLES): Promise<string[]> => {
    const { rows } = await app().query<{ key: string }>(`SELECT ${TABLES[table]} AS key FROM ${table}`);
    return rows.map((row) => row.key);
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    const system = await database.connectAs('app_system');
    try {
      await system.query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`,
        [f.orgA, f.orgB],
      );
      await system.query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $2, 'analytics-a1', 'A1', 'Europe/Berlin', 'de', now()),
                ($3, $4, 'analytics-b1', 'B1', 'America/New_York', 'en', now())`,
        [f.a1, f.orgA, f.b1, f.orgB],
      );
      for (const [ws, account, variant, snapshot] of [
        [f.a1, f.accountA, f.variantA, f.snapshotA],
        [f.b1, f.accountB, f.variantB, f.snapshotB],
      ] as const) {
        const connection = randomUUID();
        const post = randomUUID();
        await system.query(
          `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name, updated_at)
           VALUES ($1, $2, 'X', 'MOCK', 'user-1', 'Max Mock', now())`,
          [connection, ws],
        );
        await system.query(
          `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
           VALUES ($1, $2, $3, 'X', 'PROFILE', 'user-1', 'Max Mock', now())`,
          [account, ws, connection],
        );
        await system.query(
          `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
          [post, ws],
        );
        await system.query(
          `INSERT INTO post_variant (id, workspace_id, post_id, social_account_id, platform, target_key, status,
                                     published_at, updated_at)
           VALUES ($1, $2, $3, $4, 'X', 't1', 'PUBLISHED', now() - interval '2 days', now())`,
          [variant, ws, post, account],
        );
        await system.query(
          `INSERT INTO metric_snapshot (id, workspace_id, variant_id, social_account_id, platform, step,
                                        impressions, likes, raw, mapping_version, captured_at)
           VALUES ($1, $2, $3, $4, 'X', 0, 120, 6, '{}', 1, now() - interval '1 day')`,
          [snapshot, ws, variant, account],
        );
        await system.query(
          `INSERT INTO post_metric_latest (variant_id, workspace_id, social_account_id, platform, published_at,
                                           captured_at, impressions, likes, engagements, updated_at)
           VALUES ($1, $2, $3, 'X', now() - interval '2 days', now() - interval '1 day', 120, 6, 6, now())`,
          [variant, ws, account],
        );
        await system.query(
          `INSERT INTO account_metric_snapshot (id, workspace_id, social_account_id, platform, day, followers, raw,
                                                mapping_version, captured_at)
           VALUES (gen_random_uuid(), $1, $2, 'X', current_date - 1, 500, '{}', 1, now())`,
          [ws, account],
        );
        await system.query(
          `INSERT INTO analytics_daily (workspace_id, social_account_id, platform, day, impressions, likes,
                                        engagements, posts_published, followers, updated_at)
           VALUES ($1, $2, 'X', current_date - 1, 120, 6, 6, 1, 500, now())`,
          [ws, account],
        );
      }
    } finally {
      await system.end();
    }
    runtime = await database.connectAs('app_user');
  }, 300_000);

  afterAll(async () => {
    await runtime?.end();
    await database?.stop();
  });

  it('passes the RLS check with the analytics tables', async () => {
    const owner = await db().connectAs('app_migrator');
    try {
      await expect(findRlsViolations(owner)).resolves.toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it('shows the rows of the workspace in context and nothing without it', async () => {
    expect(await inA(() => keysOf('metric_snapshot'))).toEqual([f.snapshotA]);
    expect(await inA(() => keysOf('post_metric_latest'))).toEqual([f.variantA]);
    expect(await inA(() => keysOf('account_metric_snapshot'))).toEqual([f.accountA]);
    expect(await inA(() => keysOf('analytics_daily'))).toEqual([f.accountA]);
    for (const table of Object.keys(TABLES) as (keyof typeof TABLES)[]) {
      const orgOnly = await inContext(app(), { organizationId: f.orgA }, () => keysOf(table));
      expect(orgOnly, table).toEqual([]);
    }
  });

  it('rejects writes into another workspace', async () => {
    await expect(
      inA(() =>
        app().query(
          `INSERT INTO metric_snapshot (id, workspace_id, variant_id, social_account_id, platform, raw,
                                        mapping_version, captured_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'X', '{}', 1, now())`,
          [f.b1, f.variantB, f.accountB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inA(() =>
        app().query(
          `INSERT INTO analytics_daily (workspace_id, social_account_id, platform, day, updated_at)
           VALUES ($1, $2, 'X', current_date, now())`,
          [f.b1, f.accountB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    for (const [table, column] of [
      ['post_metric_latest', 'updated_at'],
      ['account_metric_snapshot', 'captured_at'],
      ['analytics_daily', 'updated_at'],
    ] as const) {
      const changed = await inA(() =>
        app().query(`UPDATE ${table} SET ${column} = now() WHERE workspace_id = $1`, [f.b1]),
      );
      expect(changed.rowCount, table).toBe(0);
    }
  });

  it('lets app_user add snapshots but never rewrite or remove them, and replace the rest', async () => {
    await inA(() =>
      app().query(
        `INSERT INTO metric_snapshot (id, workspace_id, variant_id, social_account_id, platform, step, impressions,
                                      raw, mapping_version, captured_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'X', 1, 300, '{}', 1, now())`,
        [f.a1, f.variantA, f.accountA],
      ),
    );
    for (const statement of [
      'UPDATE metric_snapshot SET impressions = 0 WHERE id = $1',
      'DELETE FROM metric_snapshot WHERE id = $1',
    ]) {
      await expect(
        inA(() => app().query(statement, [f.snapshotA])),
        statement,
      ).rejects.toThrow(/permission denied/);
    }
    const latest = await inA(() =>
      app().query(`UPDATE post_metric_latest SET impressions = 300 WHERE variant_id = $1`, [f.variantA]),
    );
    expect(latest.rowCount).toBe(1);
    const daily = await inA(() =>
      app().query(`DELETE FROM analytics_daily WHERE social_account_id = $1`, [f.accountA]),
    );
    expect(daily.rowCount).toBe(1);
  });
});
