import type { NormalizedPostMetrics } from '@smp/core';
import { z } from 'zod';

import { postPublicMetricsSchema } from './x-schemas';

// The normalization of the X API (guide step 5.2, architecture 8): public_metrics of a post and
// the followers of the account. Checked 2026-11-25 against
// https://docs.x.com/x-api/fundamentals/metrics (impression_count, like_count, reply_count,
// retweet_count, quote_count, bookmark_count) and the PostPublicMetrics schema of
// https://docs.x.com/openapi.json 2.175, which names the reposts repost_count.
// Impressions are the impressions, replies the comments, reposts and quotes the shares, bookmarks
// the saves. Reach, views and clicks are not public (url_link_clicks is a non-public metric for
// posts of the last 30 days); they stay null, never 0. Raise MAP_VERSION whenever this changes.

export const MAP_VERSION = 1;

/** The raw post answer kept with the snapshot: the post as GET /2/tweets returned it. */
export const xPostMetricsRawSchema = z.looseObject({
  id: z.string(),
  public_metrics: postPublicMetricsSchema.optional(),
});

/** The raw account answer: data of GET /2/users/me with public_metrics. */
export const xAccountMetricsRawSchema = z.looseObject({
  public_metrics: z.looseObject({ followers_count: z.number().int().nonnegative().optional() }).optional(),
});

const sum = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

/** Normalized counters from the raw post; throws when it has another shape. */
export function normalizeXPostMetrics(raw: unknown): NormalizedPostMetrics {
  const metrics = xPostMetricsRawSchema.parse(raw).public_metrics ?? {};
  const reposts = metrics.repost_count ?? metrics.retweet_count ?? null;
  return {
    impressions: metrics.impression_count ?? null,
    reach: null,
    views: null,
    likes: metrics.like_count ?? null,
    comments: metrics.reply_count ?? null,
    shares: sum(reposts, metrics.quote_count ?? null),
    clicks: null,
    saves: metrics.bookmark_count ?? null,
  };
}

/** Normalized account numbers: X reports followers only. */
export function normalizeXAccountMetrics(raw: unknown): {
  followers: number | null;
  reach: number | null;
  profileViews: number | null;
} {
  const parsed = xAccountMetricsRawSchema.parse(raw);
  return { followers: parsed.public_metrics?.followers_count ?? null, reach: null, profileViews: null };
}
