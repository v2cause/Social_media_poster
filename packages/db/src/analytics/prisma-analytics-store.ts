import type { AnalyticsStore, DueVariant } from '@smp/core';

import { Prisma } from '../generated/prisma/client';
import { createPrismaPublishJobStore } from '../publishing/prisma-publish-job-store';
import type { TenantTransaction } from '../tenant-context';

// The repositories of the analytics jobs on one transaction (guide step 5.2). The jobs run as
// app_user in the tenant of their account; every method filters by the workspace explicitly and
// row-level security limits it to the scope as well. The polls change only the metrics fields of
// a variant, with plain SQL: they leave its version and updated_at alone, so neither an open
// composer nor the order of the post list notices them.

/** The largest value of an integer column; no single post comes near it. */
const INT_MAX = 2_147_483_647;
const counter = (value: number | null): number | null => (value === null ? null : Math.min(value, INT_MAX));

/** A plain JSON copy: drops undefined values and fails on what JSON cannot hold. */
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;

/** The sum of a column of the rollup, capped at INT_MAX; null stays null, unlike with LEAST. */
const cappedSum = (column: string): Prisma.Sql =>
  Prisma.sql`CASE WHEN sum(${Prisma.raw(column)}) > ${INT_MAX} THEN ${INT_MAX} ELSE sum(${Prisma.raw(column)}) END`;

/** A date column from YYYY-MM-DD. */
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

interface DueRow {
  id: string;
  external_post_id: string;
  external_url: string | null;
  published_at: Date;
  metrics_step: number;
}

export function createPrismaAnalyticsStore(tx: TenantTransaction): AnalyticsStore {
  const publishJob = createPrismaPublishJobStore(tx);
  return {
    targets: publishJob.targets,
    connections: publishJob.connections,
    costs: publishJob.costs,

    workspaces: {
      async timeZoneOf(workspaceId) {
        const workspace = await tx.workspace.findUnique({
          where: { id: workspaceId },
          select: { timezone: true },
        });
        return workspace?.timezone ?? null;
      },
    },

    postMetrics: {
      async claimDue(workspaceId, accountId, now, limit, leaseUntil) {
        // SKIP LOCKED: a second run of the same account takes other variants or none.
        const rows = await tx.$queryRaw<DueRow[]>`
          UPDATE post_variant SET metrics_next_at = ${leaseUntil}::timestamptz
           WHERE id IN (
             SELECT id FROM post_variant
              WHERE workspace_id = ${workspaceId}::uuid
                AND social_account_id = ${accountId}::uuid
                AND status = 'PUBLISHED'
                AND NOT is_dry_run
                AND external_post_id IS NOT NULL
                AND published_at IS NOT NULL
                AND metrics_next_at <= ${now}::timestamptz
              ORDER BY metrics_next_at
              LIMIT ${limit}
                FOR UPDATE SKIP LOCKED)
          RETURNING id, external_post_id, external_url, published_at, metrics_step`;
        return rows
          .map((row): DueVariant => ({
            id: row.id,
            externalPostId: row.external_post_id,
            externalUrl: row.external_url,
            publishedAt: row.published_at,
            step: row.metrics_step,
          }))
          .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || a.id.localeCompare(b.id));
      },

      async postpone(workspaceId, variantIds, at) {
        if (variantIds.length === 0) {
          return;
        }
        await tx.$executeRaw`
          UPDATE post_variant SET metrics_next_at = ${at}::timestamptz
           WHERE workspace_id = ${workspaceId}::uuid
             AND id = ANY(${[...variantIds]}::uuid[])
             AND status = 'PUBLISHED'`;
      },

      postponeDue: (workspaceId, accountId, now, at) =>
        tx.$executeRaw`
          UPDATE post_variant SET metrics_next_at = ${at}::timestamptz
           WHERE workspace_id = ${workspaceId}::uuid
             AND social_account_id = ${accountId}::uuid
             AND status = 'PUBLISHED'
             AND metrics_next_at <= ${now}::timestamptz`,

      endDue: (workspaceId, accountId, now) =>
        tx.$executeRaw`
          UPDATE post_variant SET metrics_next_at = NULL
           WHERE workspace_id = ${workspaceId}::uuid
             AND social_account_id = ${accountId}::uuid
             AND status = 'PUBLISHED'
             AND metrics_next_at <= ${now}::timestamptz`,

      async record(workspaceId, account, capturedAt, polls) {
        for (const poll of polls) {
          if (poll.kind === 'deleted') {
            await tx.$executeRaw`
              UPDATE post_variant SET external_deleted_at = ${capturedAt}::timestamptz, metrics_next_at = NULL
               WHERE workspace_id = ${workspaceId}::uuid AND id = ${poll.variantId}::uuid`;
            continue;
          }
          const m = poll.metrics;
          const counters = {
            impressions: counter(m.impressions),
            reach: counter(m.reach),
            views: counter(m.views),
            likes: counter(m.likes),
            comments: counter(m.comments),
            shares: counter(m.shares),
            clicks: counter(m.clicks),
            saves: counter(m.saves),
          };
          await tx.metricSnapshot.create({
            data: {
              workspaceId,
              variantId: poll.variantId,
              socialAccountId: account.id,
              platform: account.platform,
              step: poll.step,
              ...counters,
              raw: json(poll.raw),
              mappingVersion: poll.mappingVersion,
              capturedAt,
            },
          });
          const engagements = counter(poll.engagements);
          // Only a newer poll replaces the latest numbers.
          await tx.$executeRaw`
            INSERT INTO post_metric_latest
              (variant_id, workspace_id, social_account_id, platform, published_at, captured_at,
               impressions, reach, views, likes, comments, shares, clicks, saves, engagements, updated_at)
            VALUES
              (${poll.variantId}::uuid, ${workspaceId}::uuid, ${account.id}::uuid,
               ${account.platform}::"Platform", ${poll.publishedAt}::timestamptz, ${capturedAt}::timestamptz,
               ${counters.impressions}, ${counters.reach}, ${counters.views}, ${counters.likes},
               ${counters.comments}, ${counters.shares}, ${counters.clicks}, ${counters.saves},
               ${engagements}, now())
            ON CONFLICT (variant_id) DO UPDATE SET
              captured_at = EXCLUDED.captured_at,
              impressions = EXCLUDED.impressions,
              reach = EXCLUDED.reach,
              views = EXCLUDED.views,
              likes = EXCLUDED.likes,
              comments = EXCLUDED.comments,
              shares = EXCLUDED.shares,
              clicks = EXCLUDED.clicks,
              saves = EXCLUDED.saves,
              engagements = EXCLUDED.engagements,
              updated_at = now()
            WHERE post_metric_latest.captured_at < EXCLUDED.captured_at`;
          await tx.$executeRaw`
            UPDATE post_variant
               SET metrics_step = ${poll.next?.step ?? poll.step + 1},
                   metrics_next_at = ${poll.next?.at ?? null}::timestamptz
             WHERE workspace_id = ${workspaceId}::uuid AND id = ${poll.variantId}::uuid`;
        }
      },
    },

    rollups: {
      async rollUp(workspaceId, from, to) {
        // One rollup per workspace at a time: the collector and the nightly run may meet.
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended('analytics_rollup:' || ${workspaceId}, 0))`;
        const written = await tx.$executeRaw`
          WITH zone AS (
            SELECT timezone FROM workspace WHERE id = ${workspaceId}::uuid
          ),
          bounds AS (
            SELECT (${from}::date::timestamp AT TIME ZONE zone.timezone) AS start_at,
                   ((${to}::date + 1)::timestamp AT TIME ZONE zone.timezone) AS end_at,
                   zone.timezone
              FROM zone
          ),
          -- The variants with a snapshot in the period; their whole history gives the deltas.
          touched AS (
            SELECT DISTINCT s.variant_id
              FROM metric_snapshot s, bounds b
             WHERE s.workspace_id = ${workspaceId}::uuid
               AND s.captured_at >= b.start_at AND s.captured_at < b.end_at
          ),
          snapshots AS (
            SELECT s.id, s.variant_id, s.social_account_id, s.platform, s.captured_at,
                   s.impressions, s.reach, s.views, s.likes, s.comments, s.shares, s.clicks, s.saves,
                   CASE WHEN num_nonnulls(s.likes, s.comments, s.shares, s.saves, s.clicks) = 0 THEN NULL
                        ELSE COALESCE(s.likes, 0) + COALESCE(s.comments, 0) + COALESCE(s.shares, 0)
                           + COALESCE(s.saves, 0) + COALESCE(s.clicks, 0)
                   END AS engagements
              FROM metric_snapshot s
              JOIN touched t ON t.variant_id = s.variant_id
             WHERE s.workspace_id = ${workspaceId}::uuid
          ),
          -- What a counter grew since the snapshot before; null stays null, a first value counts whole.
          deltas AS (
            SELECT s.social_account_id, s.platform,
                   (s.captured_at AT TIME ZONE b.timezone)::date AS day,
                   s.impressions - COALESCE(lag(s.impressions) OVER w, 0) AS impressions,
                   s.reach - COALESCE(lag(s.reach) OVER w, 0) AS post_reach,
                   s.views - COALESCE(lag(s.views) OVER w, 0) AS views,
                   s.likes - COALESCE(lag(s.likes) OVER w, 0) AS likes,
                   s.comments - COALESCE(lag(s.comments) OVER w, 0) AS comments,
                   s.shares - COALESCE(lag(s.shares) OVER w, 0) AS shares,
                   s.clicks - COALESCE(lag(s.clicks) OVER w, 0) AS clicks,
                   s.saves - COALESCE(lag(s.saves) OVER w, 0) AS saves,
                   s.engagements - COALESCE(lag(s.engagements) OVER w, 0) AS engagements
              FROM snapshots s, bounds b
            WINDOW w AS (PARTITION BY s.variant_id ORDER BY s.captured_at, s.id)
          ),
          rows AS (
            SELECT social_account_id, platform, day,
                   impressions, post_reach, views, likes, comments, shares, clicks, saves, engagements,
                   0 AS posts, NULL::int AS followers, NULL::int AS account_reach, NULL::int AS profile_views
              FROM deltas
             WHERE day BETWEEN ${from}::date AND ${to}::date
            UNION ALL
            SELECT v.social_account_id, v.platform, (v.published_at AT TIME ZONE b.timezone)::date,
                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                   1, NULL, NULL, NULL
              FROM post_variant v, bounds b
             WHERE v.workspace_id = ${workspaceId}::uuid
               AND v.status = 'PUBLISHED'
               AND NOT v.is_dry_run
               AND v.social_account_id IS NOT NULL
               AND v.published_at >= b.start_at AND v.published_at < b.end_at
            UNION ALL
            SELECT a.social_account_id, a.platform, a.day,
                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                   0, a.followers, a.reach, a.profile_views
              FROM account_metric_snapshot a
             WHERE a.workspace_id = ${workspaceId}::uuid
               AND a.day BETWEEN ${from}::date AND ${to}::date
          )
          INSERT INTO analytics_daily
            (workspace_id, social_account_id, platform, day, impressions, post_reach, views, likes,
             comments, shares, clicks, saves, engagements, posts_published, followers, account_reach,
             profile_views, updated_at)
          SELECT ${workspaceId}::uuid, social_account_id, platform, day,
                 ${cappedSum('impressions')}, ${cappedSum('post_reach')}, ${cappedSum('views')},
                 ${cappedSum('likes')}, ${cappedSum('comments')}, ${cappedSum('shares')},
                 ${cappedSum('clicks')}, ${cappedSum('saves')}, ${cappedSum('engagements')},
                 sum(posts), max(followers), max(account_reach), max(profile_views), now()::timestamptz(3)
            FROM rows
           GROUP BY social_account_id, platform, day
          ON CONFLICT (social_account_id, day) DO UPDATE SET
            impressions = EXCLUDED.impressions,
            post_reach = EXCLUDED.post_reach,
            views = EXCLUDED.views,
            likes = EXCLUDED.likes,
            comments = EXCLUDED.comments,
            shares = EXCLUDED.shares,
            clicks = EXCLUDED.clicks,
            saves = EXCLUDED.saves,
            engagements = EXCLUDED.engagements,
            posts_published = EXCLUDED.posts_published,
            followers = EXCLUDED.followers,
            account_reach = EXCLUDED.account_reach,
            profile_views = EXCLUDED.profile_views,
            updated_at = EXCLUDED.updated_at`;
        // Days of the period this run did not write have no data any more. The column keeps
        // milliseconds, so the stamp of this transaction is compared at the same precision.
        await tx.$executeRaw`
          DELETE FROM analytics_daily
           WHERE workspace_id = ${workspaceId}::uuid
             AND day BETWEEN ${from}::date AND ${to}::date
             AND updated_at <> now()::timestamptz(3)`;
        return written;
      },
    },

    accountMetrics: {
      async saveDaily(metrics) {
        const values = {
          platform: metrics.platform,
          followers: counter(metrics.followers),
          reach: counter(metrics.reach),
          profileViews: counter(metrics.profileViews),
          raw: json(metrics.raw),
          mappingVersion: metrics.mappingVersion,
          capturedAt: metrics.capturedAt,
        };
        await tx.accountMetricSnapshot.upsert({
          where: {
            socialAccountId_day: { socialAccountId: metrics.accountId, day: dateOf(metrics.day) },
          },
          create: {
            workspaceId: metrics.workspaceId,
            socialAccountId: metrics.accountId,
            day: dateOf(metrics.day),
            ...values,
          },
          update: values,
        });
      },
    },
  };
}
