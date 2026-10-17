import { randomUUID } from 'node:crypto';

import { RollUpAnalytics } from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient, PrismaAnalyticsUnitOfWork, type PrismaClient } from '../src';

// Guide step 5.3 on PostgreSQL: the rollup fills a day of the workspace in its time zone with
// what the counters grew between consecutive snapshots, the posts published that day and the
// numbers of the accounts. A missing metric stays null, the reach of the posts is added up as
// post_reach, a day without data goes, and the result does not depend on how often it runs.

const org = randomUUID();
const workspace = randomUUID();
const accountA = randomUUID();
const accountB = randomUUID();

interface DailyRow {
  account: string;
  day: string;
  impressions: number | null;
  post_reach: number | null;
  likes: number | null;
  engagements: number | null;
  posts_published: number;
  followers: number | null;
  account_reach: number | null;
}

describe('the analytics rollup on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;

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
  const rollUp = (from: string, to: string) =>
    new RollUpAnalytics({ unitOfWork: new PrismaAnalyticsUnitOfWork(base as PrismaClient) }).execute({
      organizationId: org,
      workspaceId: workspace,
      from,
      to,
    });
  const daily = () =>
    query<DailyRow>(
      `SELECT CASE social_account_id WHEN $1 THEN 'A' ELSE 'B' END AS account,
              to_char(day, 'YYYY-MM-DD') AS day, impressions, post_reach, likes, engagements,
              posts_published, followers, account_reach
         FROM analytics_daily WHERE workspace_id = $2 ORDER BY account, day`,
      [accountA, workspace],
    );

  const seedVariant = async (account: string, platform: string, publishedAt: string): Promise<string> => {
    const postId = randomUUID();
    const variantId = randomUUID();
    await query(`INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`, [
      postId,
      workspace,
    ]);
    await query(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, social_account_id, status,
                                 published_at, external_post_id, updated_at)
       VALUES ($1, $2, $3, $4, 't1', $5, 'PUBLISHED', $6, $7, now())`,
      [variantId, workspace, postId, platform, account, publishedAt, `post-${variantId}`],
    );
    return variantId;
  };
  const snapshot = async (
    variantId: string,
    account: string,
    platform: string,
    capturedAt: string,
    counters: { impressions: number; reach: number | null; likes: number; comments: number; shares: number },
  ) =>
    query(
      `INSERT INTO metric_snapshot (id, workspace_id, variant_id, social_account_id, platform, step, impressions,
                                    reach, likes, comments, shares, raw, mapping_version, captured_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, $5, $6, $7, $8, $9, '{}', 1, $10)`,
      [
        workspace,
        variantId,
        account,
        platform,
        counters.impressions,
        counters.reach,
        counters.likes,
        counters.comments,
        counters.shares,
        capturedAt,
      ],
    );

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'rollup', 'Rollup', 'Europe/Berlin', 'de', now())`,
      [workspace, org],
    );
    for (const [account, platform] of [
      [accountA, 'LINKEDIN'],
      [accountB, 'X'],
    ] as const) {
      const connection = randomUUID();
      await query(
        `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name, updated_at)
         VALUES ($1, $2, $3, 'MOCK', $4, 'Mira', now())`,
        [connection, workspace, platform, `user-${connection}`],
      );
      await query(
        `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
         VALUES ($1, $2, $3, $4, 'PROFILE', $5, 'Mira', now())`,
        [account, workspace, connection, platform, `ext-${account}`],
      );
    }
    // Published at 23:30 in Berlin on October 14; polled at 00:30 and 23:30 on October 15 and at
    // 23:30 on October 17.
    const late = await seedVariant(accountA, 'LINKEDIN', '2026-10-14T21:30:00Z');
    await snapshot(late, accountA, 'LINKEDIN', '2026-10-14T22:30:00Z', {
      impressions: 100,
      reach: 80,
      likes: 5,
      comments: 1,
      shares: 0,
    });
    await snapshot(late, accountA, 'LINKEDIN', '2026-10-15T21:30:00Z', {
      impressions: 250,
      reach: 190,
      likes: 9,
      comments: 2,
      shares: 1,
    });
    await snapshot(late, accountA, 'LINKEDIN', '2026-10-17T21:30:00Z', {
      impressions: 300,
      reach: 200,
      likes: 9,
      comments: 2,
      shares: 1,
    });
    const morning = await seedVariant(accountA, 'LINKEDIN', '2026-10-15T08:00:00Z');
    await snapshot(morning, accountA, 'LINKEDIN', '2026-10-15T09:00:00Z', {
      impressions: 40,
      reach: 30,
      likes: 2,
      comments: 0,
      shares: 0,
    });
    // X reports no reach.
    const onX = await seedVariant(accountB, 'X', '2026-10-14T10:00:00Z');
    await snapshot(onX, accountB, 'X', '2026-10-15T10:00:00Z', {
      impressions: 70,
      reach: null,
      likes: 3,
      comments: 0,
      shares: 0,
    });
    await query(
      `INSERT INTO account_metric_snapshot (id, workspace_id, social_account_id, platform, day, followers, reach,
                                            profile_views, raw, mapping_version, captured_at)
       VALUES (gen_random_uuid(), $1, $2, 'LINKEDIN', '2026-10-15', 500, 2000, 50, '{}', 1, now()),
              (gen_random_uuid(), $1, $2, 'LINKEDIN', '2026-10-16', 505, NULL, NULL, '{}', 1, now())`,
      [workspace, accountA],
    );
    // A day without data from an earlier run, and one outside the period.
    await query(
      `INSERT INTO analytics_daily (workspace_id, social_account_id, platform, day, impressions, posts_published,
                                    updated_at)
       VALUES ($1, $2, 'X', '2026-10-16', 999, 0, now() - interval '1 day'),
              ($1, $2, 'X', '2026-10-01', 7, 0, now() - interval '1 day')`,
      [workspace, accountB],
    );
    base = createPrismaClient(database.url('app_user'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await database?.stop();
  });

  it('fills the local days with the growth of the counters, the published posts and the account numbers', async () => {
    await rollUp('2026-10-14', '2026-10-17');
    const expected: DailyRow[] = [
      {
        account: 'A',
        day: '2026-10-14',
        impressions: null,
        post_reach: null,
        likes: null,
        engagements: null,
        posts_published: 1,
        followers: null,
        account_reach: null,
      },
      // 100 and 150 of the late post, 40 of the morning post; engagements 6 + 6 + 2.
      {
        account: 'A',
        day: '2026-10-15',
        impressions: 290,
        post_reach: 220,
        likes: 11,
        engagements: 14,
        posts_published: 1,
        followers: 500,
        account_reach: 2000,
      },
      {
        account: 'A',
        day: '2026-10-16',
        impressions: null,
        post_reach: null,
        likes: null,
        engagements: null,
        posts_published: 0,
        followers: 505,
        account_reach: null,
      },
      {
        account: 'A',
        day: '2026-10-17',
        impressions: 50,
        post_reach: 10,
        likes: 0,
        engagements: 0,
        posts_published: 0,
        followers: null,
        account_reach: null,
      },
      {
        account: 'B',
        day: '2026-10-01',
        impressions: 7,
        post_reach: null,
        likes: null,
        engagements: null,
        posts_published: 0,
        followers: null,
        account_reach: null,
      },
      {
        account: 'B',
        day: '2026-10-14',
        impressions: null,
        post_reach: null,
        likes: null,
        engagements: null,
        posts_published: 1,
        followers: null,
        account_reach: null,
      },
      {
        account: 'B',
        day: '2026-10-15',
        impressions: 70,
        post_reach: null,
        likes: 3,
        engagements: 3,
        posts_published: 0,
        followers: null,
        account_reach: null,
      },
    ];
    expect(await daily()).toEqual(expected);

    // Again, and a single day with the history before it: the same numbers.
    await rollUp('2026-10-14', '2026-10-17');
    await rollUp('2026-10-17', '2026-10-17');
    expect(await daily()).toEqual(expected);
  });
});
