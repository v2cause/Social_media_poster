import type { DailyMetrics } from '@smp/core';

import { Prisma, type Platform, type PrismaClient, type SocialAccountType } from '../generated/prisma/client';
import { previewOf } from '../publishing/variant-list-read-model';
import { withTenantTx, type WorkspaceRef } from '../tenant-context';

// The reads of the analytics API (guide step 5.4): the rollup per account and day, the follower
// counts before a period, the latest numbers of the posts of a period, a post with its snapshots
// and an account. Every query runs in the tenant of the workspace and filters by it explicitly;
// the API computes the KPIs from these rows with the functions of the core.

export interface AnalyticsFilter {
  /** Local days, YYYY-MM-DD, both included. */
  from: string;
  to: string;
  platforms?: readonly Platform[];
  accountIds?: readonly string[];
}

/** The posts of a period: published from `start` (inclusive) to `end` (exclusive). */
export interface PostPeriodFilter {
  start: Date;
  end: Date;
  platforms?: readonly Platform[];
  accountIds?: readonly string[];
}

export interface PostMetricsView {
  impressions: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
  engagements: number | null;
}

export interface AnalyticsPostView {
  variantId: string;
  postId: string;
  platform: Platform;
  account: { id: string; name: string; handle: string | null } | null;
  preview: string;
  publishedAt: Date;
  externalUrl: string | null;
  externalDeletedAt: Date | null;
  style: { id: string; key: string; name: string; preset: boolean } | null;
  metrics: PostMetricsView | null;
  capturedAt: Date | null;
}

export interface AnalyticsAccountView {
  id: string;
  name: string;
  handle: string | null;
  platform: Platform;
  type: SocialAccountType;
  disconnectedAt: Date | null;
}

export type TopPostsSort = 'engagements' | 'engagementRate' | 'impressions';

const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/** Rows of the export per query. */
const EXPORT_BATCH = 1_000;

/** A row of the CSV export: the rollup of an account and day with the name of the account. */
export type ExportRow = DailyMetrics & { accountName: string };
interface ExportCursor {
  day: string;
  accountId: string;
}

interface PostRow {
  variant_id: string;
  post_id: string;
  platform: Platform;
  text: string;
  published_at: Date;
  external_url: string | null;
  external_deleted_at: Date | null;
  account_id: string | null;
  account_name: string | null;
  account_handle: string | null;
  style_id: string | null;
  style_key: string | null;
  style_name: string | null;
  style_preset: boolean | null;
  captured_at: Date | null;
  impressions: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
  engagements: number | null;
}

const toPostView = (row: PostRow): AnalyticsPostView => ({
  variantId: row.variant_id,
  postId: row.post_id,
  platform: row.platform,
  account:
    row.account_id === null || row.account_name === null
      ? null
      : { id: row.account_id, name: row.account_name, handle: row.account_handle },
  preview: previewOf(row.text),
  publishedAt: row.published_at,
  externalUrl: row.external_url,
  externalDeletedAt: row.external_deleted_at,
  style:
    row.style_id === null || row.style_key === null || row.style_name === null
      ? null
      : { id: row.style_id, key: row.style_key, name: row.style_name, preset: row.style_preset === true },
  metrics:
    row.captured_at === null
      ? null
      : {
          impressions: row.impressions,
          reach: row.reach,
          views: row.views,
          likes: row.likes,
          comments: row.comments,
          shares: row.shares,
          clicks: row.clicks,
          saves: row.saves,
          engagements: row.engagements,
        },
  capturedAt: row.captured_at,
});

/** The columns of a post with its latest numbers, its account and its style. */
const POST_COLUMNS = Prisma.sql`
  v.id AS variant_id, v.post_id, v.platform, v.text, v.published_at, v.external_url, v.external_deleted_at,
  a.id AS account_id, a.name AS account_name, a.handle AS account_handle,
  s.id AS style_id, s.key AS style_key, s.name AS style_name, (s.workspace_id IS NULL) AS style_preset,
  l.captured_at, l.impressions, l.reach, l.views, l.likes, l.comments, l.shares, l.clicks, l.saves,
  l.engagements`;

const POST_JOINS = Prisma.sql`
  JOIN post p ON p.id = v.post_id
  LEFT JOIN post_style s ON s.id = p.style_id
  LEFT JOIN social_account a ON a.id = v.social_account_id`;

/** The filter of the published posts of a period, on post_variant v. */
const postPeriodWhere = (workspaceId: string, filter: PostPeriodFilter): Prisma.Sql => Prisma.sql`
  v.workspace_id = ${workspaceId}::uuid
  AND v.status = 'PUBLISHED'
  AND NOT v.is_dry_run
  AND v.published_at >= ${filter.start}::timestamptz AND v.published_at < ${filter.end}::timestamptz
  ${filter.platforms?.length ? Prisma.sql`AND v.platform::text IN (${Prisma.join([...filter.platforms])})` : Prisma.empty}
  ${filter.accountIds?.length ? Prisma.sql`AND v.social_account_id IN (${Prisma.join(filter.accountIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}`;

const TOP_ORDER: Record<TopPostsSort, Prisma.Sql> = {
  engagements: Prisma.sql`l.engagements DESC NULLS LAST`,
  engagementRate: Prisma.sql`(l.engagements::float8 / NULLIF(COALESCE(l.impressions, l.views, l.reach), 0)) DESC NULLS LAST`,
  impressions: Prisma.sql`COALESCE(l.impressions, l.views) DESC NULLS LAST`,
};

export class AnalyticsReadModel {
  constructor(private readonly base: PrismaClient) {}

  async timeZoneOf(ref: WorkspaceRef): Promise<string> {
    return withTenantTx(this.base, ref, async (tx) => {
      const workspace = await tx.workspace.findFirst({
        where: { id: ref.workspaceId, organizationId: ref.organizationId },
        select: { timezone: true },
      });
      return workspace?.timezone ?? 'UTC';
    });
  }

  /** The rollup rows of the period, in the order of day and account. */
  daily(ref: WorkspaceRef, filter: AnalyticsFilter): Promise<DailyMetrics[]> {
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.analyticsDaily.findMany({
        where: {
          workspaceId: ref.workspaceId,
          day: { gte: dateOf(filter.from), lte: dateOf(filter.to) },
          ...(filter.platforms?.length ? { platform: { in: [...filter.platforms] } } : {}),
          ...(filter.accountIds?.length ? { socialAccountId: { in: [...filter.accountIds] } } : {}),
        },
        orderBy: [{ day: 'asc' }, { socialAccountId: 'asc' }],
      });
      return rows.map((row) => ({
        accountId: row.socialAccountId,
        platform: row.platform,
        day: dayOf(row.day),
        impressions: row.impressions,
        postReach: row.postReach,
        views: row.views,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
        clicks: row.clicks,
        saves: row.saves,
        engagements: row.engagements,
        postsPublished: row.postsPublished,
        followers: row.followers,
        accountReach: row.accountReach,
        profileViews: row.profileViews,
      }));
    });
  }

  /** Per account its last follower count before the day, the baseline of a growth. */
  followerBaselines(
    ref: WorkspaceRef,
    before: string,
    filter: Pick<AnalyticsFilter, 'platforms' | 'accountIds'>,
  ): Promise<Map<string, number>> {
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.$queryRaw<{ account_id: string; followers: number }[]>`
        SELECT DISTINCT ON (social_account_id) social_account_id AS account_id, followers
          FROM account_metric_snapshot
         WHERE workspace_id = ${ref.workspaceId}::uuid
           AND day < ${before}::date
           AND followers IS NOT NULL
           ${filter.platforms?.length ? Prisma.sql`AND platform::text IN (${Prisma.join([...filter.platforms])})` : Prisma.empty}
           ${filter.accountIds?.length ? Prisma.sql`AND social_account_id IN (${Prisma.join(filter.accountIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
         ORDER BY social_account_id, day DESC`;
      return new Map(rows.map((row) => [row.account_id, row.followers]));
    });
  }

  /** The names of the accounts of the workspace, for the labels of a series per account. */
  accountNames(ref: WorkspaceRef): Promise<Map<string, string>> {
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.socialAccount.findMany({
        where: { workspaceId: ref.workspaceId },
        select: { id: true, name: true },
      });
      return new Map(rows.map((row) => [row.id, row.name]));
    });
  }

  /** The posts of the period with the most of the sort, seen at least `minImpressions` times. */
  topPosts(
    ref: WorkspaceRef,
    filter: PostPeriodFilter,
    options: { sort: TopPostsSort; limit: number; minImpressions: number },
  ): Promise<AnalyticsPostView[]> {
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.$queryRaw<PostRow[]>`
        SELECT ${POST_COLUMNS}
          FROM post_variant v
          JOIN post_metric_latest l ON l.variant_id = v.id
          ${POST_JOINS}
         WHERE ${postPeriodWhere(ref.workspaceId, filter)}
           AND COALESCE(l.impressions, l.views, l.reach, 0) >= ${options.minImpressions}
         ORDER BY ${TOP_ORDER[options.sort]}, v.published_at DESC, v.id
         LIMIT ${options.limit}`;
      return rows.map(toPostView);
    });
  }

  /** Every published post of the period with its latest numbers, for the breakdowns. */
  postsOfPeriod(ref: WorkspaceRef, filter: PostPeriodFilter): Promise<AnalyticsPostView[]> {
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.$queryRaw<PostRow[]>`
        SELECT ${POST_COLUMNS}
          FROM post_variant v
          LEFT JOIN post_metric_latest l ON l.variant_id = v.id
          ${POST_JOINS}
         WHERE ${postPeriodWhere(ref.workspaceId, filter)}
         ORDER BY v.published_at, v.id`;
      return rows.map(toPostView);
    });
  }

  /** A published post with its latest numbers and every snapshot, oldest first. */
  post(
    ref: WorkspaceRef,
    variantId: string,
  ): Promise<
    | (AnalyticsPostView & {
        snapshots: { capturedAt: Date; step: number | null; metrics: PostMetricsView }[];
      })
    | null
  > {
    return withTenantTx(this.base, ref, async (tx) => {
      const [row] = await tx.$queryRaw<PostRow[]>`
        SELECT ${POST_COLUMNS}
          FROM post_variant v
          LEFT JOIN post_metric_latest l ON l.variant_id = v.id
          ${POST_JOINS}
         WHERE v.workspace_id = ${ref.workspaceId}::uuid
           AND v.id = ${variantId}::uuid
           AND v.published_at IS NOT NULL
           AND v.status = 'PUBLISHED'`;
      if (!row) {
        return null;
      }
      const snapshots = await tx.metricSnapshot.findMany({
        where: { workspaceId: ref.workspaceId, variantId },
        orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
      });
      return {
        ...toPostView(row),
        snapshots: snapshots.map((snapshot) => ({
          capturedAt: snapshot.capturedAt,
          step: snapshot.step,
          metrics: {
            impressions: snapshot.impressions,
            reach: snapshot.reach,
            views: snapshot.views,
            likes: snapshot.likes,
            comments: snapshot.comments,
            shares: snapshot.shares,
            clicks: snapshot.clicks,
            saves: snapshot.saves,
            engagements: null,
          },
        })),
      };
    });
  }

  account(ref: WorkspaceRef, accountId: string): Promise<AnalyticsAccountView | null> {
    return withTenantTx(this.base, ref, (tx) =>
      tx.socialAccount.findFirst({
        where: { id: accountId, workspaceId: ref.workspaceId },
        select: { id: true, name: true, handle: true, platform: true, type: true, disconnectedAt: true },
      }),
    );
  }

  /** The rollup rows of the period for the CSV export, a batch at a time, with the account names. */
  async *exportDaily(ref: WorkspaceRef, filter: AnalyticsFilter): AsyncGenerator<ExportRow[]> {
    let after: ExportCursor | null = null;
    for (;;) {
      const rows = await this.exportBatch(ref, filter, after);
      if (rows.length > 0) {
        yield rows;
      }
      const last = rows.at(-1);
      if (!last || rows.length < EXPORT_BATCH) {
        return;
      }
      after = { day: last.day, accountId: last.accountId };
    }
  }

  private exportBatch(
    ref: WorkspaceRef,
    filter: AnalyticsFilter,
    after: ExportCursor | null,
  ): Promise<ExportRow[]> {
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.analyticsDaily.findMany({
        where: {
          workspaceId: ref.workspaceId,
          day: { gte: dateOf(filter.from), lte: dateOf(filter.to) },
          ...(filter.platforms?.length ? { platform: { in: [...filter.platforms] } } : {}),
          ...(filter.accountIds?.length ? { socialAccountId: { in: [...filter.accountIds] } } : {}),
          ...(after
            ? {
                OR: [
                  { day: { gt: dateOf(after.day) } },
                  { day: dateOf(after.day), socialAccountId: { gt: after.accountId } },
                ],
              }
            : {}),
        },
        include: { socialAccount: { select: { name: true } } },
        orderBy: [{ day: 'asc' }, { socialAccountId: 'asc' }],
        take: EXPORT_BATCH,
      });
      return rows.map((row) => ({
        accountId: row.socialAccountId,
        accountName: row.socialAccount.name,
        platform: row.platform,
        day: dayOf(row.day),
        impressions: row.impressions,
        postReach: row.postReach,
        views: row.views,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
        clicks: row.clicks,
        saves: row.saves,
        engagements: row.engagements,
        postsPublished: row.postsPublished,
        followers: row.followers,
        accountReach: row.accountReach,
        profileViews: row.profileViews,
      }));
    });
  }
}
