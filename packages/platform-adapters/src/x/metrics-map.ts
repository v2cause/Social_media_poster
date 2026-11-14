import type { NormalizedPostMetrics } from '@smp/core';
import { z } from 'zod';

// The normalization of the X API (guide step 5.2, architecture 8): the public metrics of a post.
// Retweets and quotes count as shares, bookmarks as saves. The raw answer stays with the
// snapshot; MAP_VERSION rises whenever this mapping changes.

export const X_MAP_VERSION = 1;

const count = z.number().int().nonnegative().optional();

export const publicMetricsSchema = z
  .object({
    retweet_count: count,
    reply_count: count,
    like_count: count,
    quote_count: count,
    bookmark_count: count,
    impression_count: count,
  })
  .loose();

export const xPostRawSchema = z.object({ x: z.object({ public_metrics: publicMetricsSchema }) });

export function normalizeXPostMetrics(raw: unknown): NormalizedPostMetrics {
  const metrics = xPostRawSchema.parse(raw).x.public_metrics;
  const shares =
    metrics.retweet_count === undefined && metrics.quote_count === undefined
      ? null
      : (metrics.retweet_count ?? 0) + (metrics.quote_count ?? 0);
  return {
    impressions: metrics.impression_count ?? null,
    reach: null,
    views: null,
    likes: metrics.like_count ?? null,
    comments: metrics.reply_count ?? null,
    shares,
    clicks: null,
    saves: metrics.bookmark_count ?? null,
  };
}

export const xAccountRawSchema = z.object({
  x: z.object({ followers_count: z.number().int().nonnegative().nullable() }),
});

export function normalizeXAccountMetrics(raw: unknown): {
  followers: number | null;
  reach: number | null;
  profileViews: number | null;
} {
  return { followers: xAccountRawSchema.parse(raw).x.followers_count, reach: null, profileViews: null };
}
