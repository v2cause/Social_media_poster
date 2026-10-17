import { randomUUID } from 'node:crypto';

import { daysBefore, localDayOf, localDayRange, RollUpAnalytics } from '@smp/core';
import type {
  AnalyticsAccountDto,
  AnalyticsBreakdownDto,
  AnalyticsOverviewDto,
  AnalyticsPostDetailDto,
  AnalyticsTimeseriesDto,
  AnalyticsTopPostsDto,
} from '@smp/contracts';
import {
  createPrismaClient,
  DEMO_USERS,
  DEMO_WORKSPACE_SLUG,
  PrismaAnalyticsUnitOfWork,
  seedDemoData,
} from '@smp/db';
import Redis from 'ioredis';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { signIn, type Browser } from './support/browser';
import { onPlan } from './support/plan';

// Guide step 5.4 through the API: KPIs of the last 30 days against the 30 before, series per
// platform, top posts, breakdowns, a post with its snapshots, an account and the CSV export, all
// computed from the rollup and the latest snapshots of the posts. Days are local days in Berlin,
// counted back from today, so the test runs on any date.

const SEED_PASSWORD = 'seed-password-for-the-analytics-test';
const ws = `/api/w/${DEMO_WORKSPACE_SLUG}`;
const ZONE = 'Europe/Berlin';
const HOUR = 60 * 60 * 1000;

const viewerEmail = (): string => {
  const user = DEMO_USERS.find((candidate) => candidate.role === 'VIEWER');
  if (!user) {
    throw new Error('no demo viewer');
  }
  return user.email;
};

const today = localDayOf(new Date(), ZONE);
/** A local day a number of days before today. */
const d = (days: number): string => daysBefore(today, days);
/** An hour of a local day a number of days before today, as an instant. */
const at = (days: number, hour: number): Date =>
  new Date(localDayRange(d(days), ZONE).from.getTime() + hour * HOUR);

describe('analytics API', () => {
  let api: ApiTestApp | undefined;
  let system: Client | undefined;
  let viewer: Browser | undefined;
  let workspaceId = '';
  let organizationId = '';
  const linkedin = randomUUID();
  const instagram = randomUUID();
  const variants = { story: randomUUID(), plain: randomUUID(), reel: randomUUID(), old: randomUUID() };

  const as = (): Browser => {
    if (!viewer) {
      throw new Error('not signed in');
    }
    return viewer;
  };
  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };
  const sql = async (text: string, values: unknown[] = []): Promise<void> => {
    if (!system) {
      throw new Error('database not ready');
    }
    await system.query(text, values);
  };

  const seedAccount = async (id: string, platform: string, type: string, name: string): Promise<void> => {
    const connectionId = randomUUID();
    await sql(
      `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name, updated_at)
       VALUES ($1, $2, $3, 'MOCK', $4, $5, now())`,
      [connectionId, workspaceId, platform, `user-${id}`, name],
    );
    await sql(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [id, workspaceId, connectionId, platform, type, `ext-${id}`, name],
    );
  };
  interface Counters {
    impressions: number | null;
    reach: number | null;
    views: number | null;
    likes: number;
    comments: number;
    shares: number;
    saves: number | null;
  }
  const seedPost = async (
    variantId: string,
    accountId: string,
    platform: string,
    publishedAt: Date,
    snapshots: [Date, Counters][],
    styleKey: string | null = null,
  ): Promise<void> => {
    const postId = randomUUID();
    await sql(
      `INSERT INTO post (id, workspace_id, language, style_id, updated_at)
       VALUES ($1, $2, 'de', (SELECT id FROM post_style WHERE key = $3 AND workspace_id IS NULL), now())`,
      [postId, workspaceId, styleKey],
    );
    await sql(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, text, social_account_id, status,
                                 published_at, external_post_id, external_url, updated_at)
       VALUES ($1, $2, $3, $4, 't1', $5, $6, 'PUBLISHED', $7, $8, $9, now())`,
      [
        variantId,
        workspaceId,
        postId,
        platform,
        `Beitrag ${variantId}`,
        accountId,
        publishedAt,
        `post-${variantId}`,
        `https://example.test/${variantId}`,
      ],
    );
    for (const [capturedAt, c] of snapshots) {
      await sql(
        `INSERT INTO metric_snapshot (id, workspace_id, variant_id, social_account_id, platform, step, impressions,
                                      reach, views, likes, comments, shares, saves, raw, mapping_version, captured_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, $5, $6, $7, $8, $9, $10, $11, '{}', 1, $12)`,
        [
          workspaceId,
          variantId,
          accountId,
          platform,
          c.impressions,
          c.reach,
          c.views,
          c.likes,
          c.comments,
          c.shares,
          c.saves,
          capturedAt,
        ],
      );
    }
    const last = snapshots.at(-1);
    if (last) {
      const [capturedAt, c] = last;
      await sql(
        `INSERT INTO post_metric_latest (variant_id, workspace_id, social_account_id, platform, published_at,
                                         captured_at, impressions, reach, views, likes, comments, shares, saves,
                                         engagements, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())`,
        [
          variantId,
          workspaceId,
          accountId,
          platform,
          publishedAt,
          capturedAt,
          c.impressions,
          c.reach,
          c.views,
          c.likes,
          c.comments,
          c.shares,
          c.saves,
          c.likes + c.comments + c.shares + (c.saves ?? 0),
        ],
      );
    }
  };
  const seedFollowers = async (
    accountId: string,
    platform: string,
    days: number,
    followers: number,
    reach: number | null,
  ) =>
    sql(
      `INSERT INTO account_metric_snapshot (id, workspace_id, social_account_id, platform, day, followers, reach, raw,
                                            mapping_version, captured_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, '{}', 1, now())`,
      [workspaceId, accountId, platform, d(days), followers, reach],
    );

  beforeAll(async () => {
    api = await startApiTestApp();
    const seed = createPrismaClient(api.database.url('app_system'));
    try {
      await seedDemoData(seed, SEED_PASSWORD);
      const workspace = await seed.workspace.findFirstOrThrow({ where: { slug: DEMO_WORKSPACE_SLUG } });
      workspaceId = workspace.id;
      organizationId = workspace.organizationId;
    } finally {
      await seed.$disconnect();
    }
    system = await api.database.connectAs('app_system');
    await seedAccount(linkedin, 'LINKEDIN', 'PROFILE', 'Mira Mock');
    await seedAccount(instagram, 'INSTAGRAM', 'BUSINESS', '=Studio, Kiel');
    const lin = (
      impressions: number,
      reach: number,
      likes: number,
      comments: number,
      shares: number,
    ): Counters => ({
      impressions,
      reach,
      views: null,
      likes,
      comments,
      shares,
      saves: null,
    });
    await seedPost(
      variants.story,
      linkedin,
      'LINKEDIN',
      at(3, 8),
      [
        [at(3, 9), lin(100, 80, 5, 1, 0)],
        [at(2, 9), lin(300, 250, 12, 2, 1)],
      ],
      'storytelling',
    );
    await seedPost(variants.plain, linkedin, 'LINKEDIN', at(20, 8), [[at(19, 9), lin(50, 40, 1, 0, 0)]]);
    await seedPost(variants.reel, instagram, 'INSTAGRAM', at(2, 9), [
      [at(2, 11), { impressions: null, reach: 300, views: 400, likes: 20, comments: 3, shares: 2, saves: 4 }],
    ]);
    await seedPost(variants.old, linkedin, 'LINKEDIN', at(40, 8), [[at(39, 9), lin(70, 60, 3, 0, 0)]]);
    await seedFollowers(linkedin, 'LINKEDIN', 31, 480, null);
    await seedFollowers(linkedin, 'LINKEDIN', 10, 500, null);
    await seedFollowers(linkedin, 'LINKEDIN', 1, 520, null);
    await seedFollowers(instagram, 'INSTAGRAM', 5, 1_000, 5_000);
    await seedFollowers(instagram, 'INSTAGRAM', 1, 1_010, null);

    const app = createPrismaClient(api.database.url('app_user'));
    try {
      await new RollUpAnalytics({ unitOfWork: new PrismaAnalyticsUnitOfWork(app) }).execute({
        organizationId,
        workspaceId,
        from: d(60),
        to: today,
      });
    } finally {
      await app.$disconnect();
    }
    viewer = await signIn(api, viewerEmail(), SEED_PASSWORD);
    // Pro keeps a year of analytics (guide step 7.4).
    await onPlan(api, organizationId, 'pro');
  }, 300_000);

  afterAll(async () => {
    await system?.end();
    await api?.close();
  });

  it('compares the KPIs of the last 30 days with the 30 days before and keeps the overview in Redis', async () => {
    const overview = (await as().get(`${ws}/analytics/overview`).expect(200)).body as AnalyticsOverviewDto;

    expect(overview.period).toEqual({ from: d(29), to: today });
    expect(overview.previous).toEqual({ from: d(59), to: d(30) });
    expect(overview.historyFrom).toBe(d(364));
    expect(overview.kpis).toEqual({
      // LinkedIn 100 + 200 + 50, Instagram reports views: 400.
      impressions: { value: 750, previous: 70 },
      // LinkedIn adds up the reach of its posts, Instagram has its own reach.
      reach: { value: 290 + 5_000, previous: 60, basis: 'mixed' },
      engagements: { value: 45, previous: 3 },
      engagementRate: { value: 45 / 750, previous: 3 / 70 },
      // LinkedIn from 480 before the period to 520, Instagram from its first count 1000 to 1010.
      followerGrowth: { value: 50, previous: 0 },
      postsPublished: { value: 3, previous: 1 },
    });
    expect(overview.series.days).toHaveLength(30);
    expect(overview.series.impressions.at(-3)).toBe(200 + 400);
    expect(overview.series.followers.at(-2)).toBe(1_530);

    const redis = new Redis(api?.env.REDIS_URL ?? '');
    try {
      expect(await redis.keys(`analytics:overview:${workspaceId}:*`)).toHaveLength(1);
    } finally {
      redis.disconnect();
    }
  });

  it('builds series per platform and per account', async () => {
    const perPlatform = (
      await as()
        .get(`${ws}/analytics/timeseries?from=${d(3)}&to=${today}&metric=impressions`)
        .expect(200)
    ).body as AnalyticsTimeseriesDto;
    expect(perPlatform.buckets).toEqual([d(3), d(2), d(1), d(0)]);
    expect(perPlatform.series).toEqual([
      { key: 'INSTAGRAM', platform: 'INSTAGRAM', label: null, values: [null, 400, null, null] },
      { key: 'LINKEDIN', platform: 'LINKEDIN', label: null, values: [100, 200, null, null] },
    ]);

    const followers = (
      await as()
        .get(
          `${ws}/analytics/timeseries?from=${d(3)}&to=${today}&metric=followers&groupBy=account&platform=LINKEDIN`,
        )
        .expect(200)
    ).body as AnalyticsTimeseriesDto;
    expect(followers.series).toEqual([
      { key: linkedin, platform: 'LINKEDIN', label: 'Mira Mock', values: [500, 500, 520, 520] },
    ]);
  });

  it('lists the top posts by engagements or rate and leaves out posts seen too rarely', async () => {
    const top = (await as().get(`${ws}/analytics/top-posts`).expect(200)).body as AnalyticsTopPostsDto;
    expect(top.items.map((item) => [item.variantId, item.engagementRate])).toEqual([
      [variants.reel, 29 / 400],
      [variants.story, 15 / 300],
    ]);
    expect(top.items[1]).toMatchObject({
      platform: 'LINKEDIN',
      account: { id: linkedin, name: 'Mira Mock' },
      style: { key: 'storytelling', preset: true },
      metrics: { impressions: 300, saves: null, engagements: 15 },
    });
    const all = (await as().get(`${ws}/analytics/top-posts?sort=impressions&minImpressions=0`).expect(200))
      .body as AnalyticsTopPostsDto;
    expect(all.items.map((item) => item.variantId)).toEqual([variants.reel, variants.story, variants.plain]);
  });

  it('breaks the posts of the period down by platform and by style', async () => {
    const platforms = (await as().get(`${ws}/analytics/breakdown?by=platform`).expect(200))
      .body as AnalyticsBreakdownDto;
    expect(platforms.groups).toEqual([
      {
        key: 'LINKEDIN',
        label: null,
        preset: null,
        posts: 2,
        impressions: 350,
        engagements: 16,
        engagementRate: 16 / 350,
      },
      {
        key: 'INSTAGRAM',
        label: null,
        preset: null,
        posts: 1,
        impressions: 400,
        engagements: 29,
        engagementRate: 29 / 400,
      },
    ]);
    const styles = (await as().get(`${ws}/analytics/breakdown?by=style`).expect(200))
      .body as AnalyticsBreakdownDto;
    expect(styles.groups.map((group) => [group.label, group.posts])).toEqual([
      [null, 2],
      ['storytelling', 1],
    ]);
  });

  it('shows a post with its snapshots and an account with its days', async () => {
    const post = (await as().get(`${ws}/analytics/posts/${variants.story}`).expect(200))
      .body as AnalyticsPostDetailDto;
    expect(
      post.snapshots.map((snapshot) => [snapshot.metrics.impressions, snapshot.metrics.engagements]),
    ).toEqual([
      [100, 6],
      [300, 15],
    ]);
    expect((await as().get(`${ws}/analytics/posts/${randomUUID()}`).expect(404)).body).toMatchObject({
      code: 'VARIANT_NOT_FOUND',
    });

    const account = (
      await as()
        .get(`${ws}/analytics/accounts/${instagram}?from=${d(5)}&to=${d(1)}`)
        .expect(200)
    ).body as AnalyticsAccountDto;
    expect(account.account).toMatchObject({ name: '=Studio, Kiel', platform: 'INSTAGRAM' });
    expect(account.days.map((day) => [day.day, day.followers, day.accountReach, day.postsPublished])).toEqual(
      [
        [d(5), 1_000, 5_000, 0],
        [d(4), null, null, 0],
        [d(3), null, null, 0],
        [d(2), null, null, 1],
        [d(1), 1_010, null, 0],
      ],
    );
    await as().get(`${ws}/analytics/accounts/${randomUUID()}`).expect(404);
  });

  it('streams the rollup as CSV with empty cells for metrics that are not reported', async () => {
    const response = await as()
      .get(`${ws}/analytics/export.csv?from=${d(2)}&to=${d(1)}`)
      .expect(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="analytics-${d(2)}-${d(1)}.csv"`,
    );
    const lines = response.text.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'day,platform,account,impressions,post_reach,views,likes,comments,shares,clicks,saves,engagements,engagement_rate,posts_published,followers,account_reach,profile_views',
    );
    expect(lines.slice(1).sort()).toEqual(
      [
        `${d(2)},INSTAGRAM,"'=Studio, Kiel",,300,400,20,3,2,,4,29,0.072500,1,,,`,
        `${d(2)},LINKEDIN,Mira Mock,200,170,,7,1,1,,,9,0.045000,0,,,`,
        `${d(1)},INSTAGRAM,"'=Studio, Kiel",,,,,,,,,,,0,1010,,`,
        `${d(1)},LINKEDIN,Mira Mock,,,,,,,,,,,0,520,,`,
      ].sort(),
    );
  });

  it('refuses a period before the analytics history and one that ends before it starts', async () => {
    expect(
      (
        await as()
          .get(`${ws}/analytics/overview?from=${d(400)}`)
          .expect(422)
      ).body,
    ).toMatchObject({
      code: 'ANALYTICS_HISTORY_EXCEEDED',
      params: { earliest: d(364) },
    });
    // The 30 days of the trial, as an override of the operators.
    await onPlan(started(), organizationId, 'pro', { analyticsHistoryDays: 30 });
    try {
      expect(
        (
          await as()
            .get(`${ws}/analytics/overview?from=${d(40)}`)
            .expect(422)
        ).body,
      ).toMatchObject({ params: { earliest: d(29) } });
    } finally {
      await onPlan(started(), organizationId, 'pro');
    }
    expect(
      (
        await as()
          .get(`${ws}/analytics/overview?from=${d(1)}&to=${d(2)}`)
          .expect(400)
      ).body,
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
