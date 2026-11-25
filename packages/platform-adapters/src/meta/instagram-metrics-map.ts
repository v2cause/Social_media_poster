import type { NormalizedPostMetrics } from '@smp/core';
import { z } from 'zod';

import { graphInsightsSchema, insightValue } from './facebook-metrics-map';

// The normalization of Instagram media (guide step 5.2, architecture 8). Media insights, checked
// 2026-11-25:
// https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights
// - impressions: "For media created after July 2, 2024, this metric is deprecated", so null;
// - views, reach, likes, comments, shares, saved: FEED posts;
// - "If insights data you are requesting does not exist or is currently unavailable, the API
//   returns an empty data set instead of 0", so a missing metric is null;
// - clicks have no media metric for feed posts.
// Account insights, checked 2026-11-25:
// https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights
// - reach (period day, metric_type total_value); profile views are not offered for accounts.

export const INSTAGRAM_MAP_VERSION = 1;

/** The metrics asked for per media, in one call. */
export const INSTAGRAM_MEDIA_METRICS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved'] as const;

export const instagramPostMetricsRawSchema = z.object({
  instagram: z.object({ insights: graphInsightsSchema }),
});

export function normalizeInstagramPostMetrics(raw: unknown): NormalizedPostMetrics {
  const { insights } = instagramPostMetricsRawSchema.parse(raw).instagram;
  return {
    impressions: null,
    reach: insightValue(insights, 'reach'),
    views: insightValue(insights, 'views'),
    likes: insightValue(insights, 'likes'),
    comments: insightValue(insights, 'comments'),
    shares: insightValue(insights, 'shares'),
    clicks: null,
    saves: insightValue(insights, 'saved'),
  };
}

export const instagramAccountMetricsRawSchema = z.object({
  instagram: z.object({
    user: z.object({ id: z.string(), followers_count: z.number().int().nonnegative().optional() }),
    insights: graphInsightsSchema.nullable(),
  }),
});

export function normalizeInstagramAccountMetrics(raw: unknown): {
  followers: number | null;
  reach: number | null;
  profileViews: number | null;
} {
  const { user, insights } = instagramAccountMetricsRawSchema.parse(raw).instagram;
  return {
    followers: user.followers_count ?? null,
    reach: insightValue(insights, 'reach'),
    profileViews: null,
  };
}
