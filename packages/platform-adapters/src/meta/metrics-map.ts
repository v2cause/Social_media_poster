import type { NormalizedPostMetrics } from '@smp/core';
import { z } from 'zod';

// The normalization of Facebook and Instagram (guide step 5.2, architecture 8). Meta renames its
// insights often ("views" replaced "impressions"), so the raw answer stays with every snapshot and
// a missing metric is null. The engagement counters come from the fields of the object, which
// change less. MAP_VERSION rises whenever this mapping changes.

export const FACEBOOK_MAP_VERSION = 1;
export const INSTAGRAM_MAP_VERSION = 1;

/** The post insights Facebook is asked for; not confirmed against the Graph API reference. */
export const FACEBOOK_POST_INSIGHTS = ['post_media_view', 'post_impressions_unique', 'post_clicks'] as const;
/** The media insights Instagram is asked for. */
export const INSTAGRAM_MEDIA_INSIGHTS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved'] as const;

const count = z.number().int().nonnegative();
const insightsSchema = z.record(z.string(), count).nullable();

export const facebookPostRawSchema = z.object({
  facebook: z.object({
    fields: z
      .object({
        shares: z.object({ count }).optional(),
        reactions: z
          .object({ summary: z.object({ total_count: count }).loose() })
          .loose()
          .optional(),
        comments: z
          .object({ summary: z.object({ total_count: count }).loose() })
          .loose()
          .optional(),
      })
      .loose(),
    insights: insightsSchema,
  }),
});

export const instagramPostRawSchema = z.object({
  instagram: z.object({
    fields: z.object({ like_count: count.optional(), comments_count: count.optional() }).loose().nullable(),
    insights: insightsSchema,
  }),
});

/** The insights answer: { data: [{ name, values: [{ value }] } or { name, total_value: { value } }] }. */
export const insightsAnswerSchema = z.object({
  data: z.array(
    z
      .object({
        name: z.string(),
        values: z.array(z.object({ value: z.unknown() }).loose()).optional(),
        total_value: z.object({ value: z.unknown() }).loose().optional(),
      })
      .loose(),
  ),
});

/** The latest number of each insight; values that are not counts are left out. */
export function insightValues(answer: z.infer<typeof insightsAnswerSchema>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const entry of answer.data) {
    const value = entry.total_value?.value ?? entry.values?.at(-1)?.value;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      values[entry.name] = value;
    }
  }
  return values;
}

const NONE: NormalizedPostMetrics = {
  impressions: null,
  reach: null,
  views: null,
  likes: null,
  comments: null,
  shares: null,
  clicks: null,
  saves: null,
};

export function normalizeFacebookPostMetrics(raw: unknown): NormalizedPostMetrics {
  const { fields, insights } = facebookPostRawSchema.parse(raw).facebook;
  return {
    ...NONE,
    views: insights?.post_media_view ?? null,
    reach: insights?.post_impressions_unique ?? null,
    clicks: insights?.post_clicks ?? null,
    likes: fields.reactions?.summary.total_count ?? null,
    comments: fields.comments?.summary.total_count ?? null,
    // Facebook leaves the field out while nobody shared the post.
    shares: fields.shares?.count ?? 0,
  };
}

export function normalizeInstagramPostMetrics(raw: unknown): NormalizedPostMetrics {
  const { fields, insights } = instagramPostRawSchema.parse(raw).instagram;
  return {
    ...NONE,
    views: insights?.views ?? null,
    reach: insights?.reach ?? null,
    likes: insights?.likes ?? fields?.like_count ?? null,
    comments: insights?.comments ?? fields?.comments_count ?? null,
    shares: insights?.shares ?? null,
    saves: insights?.saved ?? null,
  };
}

export const metaAccountRawSchema = z.object({
  meta: z.object({ followers: count.nullable() }),
});

export function normalizeMetaAccountMetrics(raw: unknown): {
  followers: number | null;
  reach: number | null;
  profileViews: number | null;
} {
  const { meta } = metaAccountRawSchema.parse(raw);
  return { followers: meta.followers, reach: null, profileViews: null };
}
