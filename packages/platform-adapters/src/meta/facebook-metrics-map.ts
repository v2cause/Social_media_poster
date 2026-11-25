import type { NormalizedPostMetrics } from '@smp/core';
import { z } from 'zod';

// The normalization of Facebook Page posts (guide step 5.2, architecture 8). The raw answer keeps
// the post fields and the insights; MAP_VERSION is raised whenever the mapping changes.
//
// Metrics, checked 2026-11-25: https://developers.facebook.com/docs/graph-api/reference/v27.0/insights
// - post_impressions and post_impressions_unique are "Deprecated above Graph API v25", so
//   impressions stay null;
// - views: post_media_view, "The number of times your content was played or displayed";
// - reach: post_total_media_view_unique, "The number of total unique media viewers for FB post";
// - clicks: post_clicks;
// - "Page Insights data is only available on Pages with 100 or more likes": smaller Pages get no
//   insights, then these stay null.
// Likes, comments and shares come from the post itself: reactions and comments with
// summary(total_count), shares.count. Graph leaves shares out of a post nobody shared (observed
// behavior, not settled by the docs), so a missing shares field counts as 0. Saves do not exist on
// Facebook.

export const FACEBOOK_MAP_VERSION = 1;

const count = z.number().int().nonnegative();

const insightSchema = z.object({
  name: z.string(),
  values: z.array(z.object({ value: z.unknown() })).optional(),
  total_value: z.object({ value: z.unknown() }).optional(),
});

export const graphInsightsSchema = z.object({ data: z.array(insightSchema) });
export type GraphInsights = z.infer<typeof graphInsightsSchema>;

export const facebookPostFieldsSchema = z.object({
  id: z.string(),
  shares: z.object({ count }).optional(),
  comments: z.object({ summary: z.object({ total_count: count }).optional() }).optional(),
  reactions: z.object({ summary: z.object({ total_count: count }).optional() }).optional(),
});

export const facebookPostMetricsRawSchema = z.object({
  facebook: z.object({
    post: facebookPostFieldsSchema,
    insights: graphInsightsSchema.nullable(),
  }),
});
export type FacebookPostMetricsRaw = z.infer<typeof facebookPostMetricsRawSchema>;

/** The value of a metric: the last value of a period, or the total; null when missing. */
export function insightValue(insights: GraphInsights | null, name: string): number | null {
  const entry = insights?.data.find((item) => item.name === name);
  if (!entry) {
    return null;
  }
  const raw = entry.total_value?.value ?? entry.values?.at(-1)?.value;
  const parsed = count.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function normalizeFacebookPostMetrics(raw: unknown): NormalizedPostMetrics {
  const { post, insights } = facebookPostMetricsRawSchema.parse(raw).facebook;
  return {
    impressions: null,
    reach: insightValue(insights, 'post_total_media_view_unique'),
    views: insightValue(insights, 'post_media_view'),
    likes: post.reactions?.summary?.total_count ?? null,
    comments: post.comments?.summary?.total_count ?? null,
    shares: post.shares?.count ?? 0,
    clicks: insightValue(insights, 'post_clicks'),
    saves: null,
  };
}

export const facebookAccountMetricsRawSchema = z.object({
  facebook: z.object({
    page: z.object({ id: z.string(), followers_count: count.optional(), fan_count: count.optional() }),
    insights: graphInsightsSchema.nullable(),
  }),
});

/**
 * followers_count of the Page; reach and profile views of the last day of the range from
 * page_total_media_view_unique and page_views_total (period day).
 */
export function normalizeFacebookAccountMetrics(raw: unknown): {
  followers: number | null;
  reach: number | null;
  profileViews: number | null;
} {
  const { page, insights } = facebookAccountMetricsRawSchema.parse(raw).facebook;
  return {
    followers: page.followers_count ?? page.fan_count ?? null,
    reach: insightValue(insights, 'page_total_media_view_unique'),
    profileViews: insightValue(insights, 'page_views_total'),
  };
}
