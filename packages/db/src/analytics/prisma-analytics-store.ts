import type { AnalyticsStore, DueVariant } from '@smp/core';

import type { Prisma } from '../generated/prisma/client';
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
