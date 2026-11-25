import type { NormalizedPostMetrics } from '@smp/core';
import { z } from 'zod';

// The normalization of LinkedIn metrics (guide step 5.2, architecture 8). The raw answer, which the
// snapshot keeps, is stored under "linkedin" with its source; MAP_VERSION is raised whenever the
// mapping changes, so older snapshots can be computed again from their raw answers. A value
// LinkedIn does not report stays null, never 0.
// Sources:
// - memberCreatorPostAnalytics (personal posts, r_member_postAnalytics):
//   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics
// - organizationalEntityShareStatistics (page posts, rw_organization_admin):
//   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics
// - memberFollowersCount, networkSizes (followers):
//   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/follower-statistics
//   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api
// (all checked 2026-11-25)

export const MAP_VERSION = 1;

/**
 * The metrics asked for per personal post, one call each: impressions, members reached (unique
 * impressions), reactions (all reaction types), comments and reshares. The current version also
 * offers POST_SAVE, LINK_CLICKS and more; they are left out to save calls, because the member
 * limit of the Development tier is small.
 */
export const MEMBER_POST_METRICS = [
  'IMPRESSION',
  'MEMBERS_REACHED',
  'REACTION',
  'COMMENT',
  'RESHARE',
] as const;
export type MemberPostMetric = (typeof MEMBER_POST_METRICS)[number];

/** Why there are no numbers: the app lacks the permission (or the page feature) for them. */
export const UNAVAILABLE_REASONS = [
  'MEMBER_POST_ANALYTICS_NOT_ENABLED',
  'MEMBER_FOLLOWER_STATISTICS_NOT_ENABLED',
] as const;

const count = z.number().int().nullable();

const memberPostRawSchema = z.object({
  source: z.literal('memberCreatorPostAnalytics'),
  counts: z.object({
    IMPRESSION: count,
    MEMBERS_REACHED: count,
    REACTION: count,
    COMMENT: count,
    RESHARE: count,
  }),
});

const organizationPostRawSchema = z.object({
  source: z.literal('organizationalEntityShareStatistics'),
  /** null: the post was not among the elements, which the docs define as all counts 0. */
  totalShareStatistics: z
    .object({
      impressionCount: z.number().int().optional(),
      uniqueImpressionsCount: z.number().int().optional(),
      clickCount: z.number().int().optional(),
      likeCount: z.number().int().optional(),
      commentCount: z.number().int().optional(),
      shareCount: z.number().int().optional(),
    })
    .nullable(),
});

const unavailableRawSchema = z.object({ source: z.literal('none'), reason: z.enum(UNAVAILABLE_REASONS) });

export const linkedInPostMetricsRawSchema = z.object({
  linkedin: z.discriminatedUnion('source', [
    memberPostRawSchema,
    organizationPostRawSchema,
    unavailableRawSchema,
  ]),
});
export type LinkedInPostMetricsRaw = z.infer<typeof linkedInPostMetricsRawSchema>;

export const linkedInAccountMetricsRawSchema = z.object({
  linkedin: z.discriminatedUnion('source', [
    z.object({ source: z.literal('memberFollowersCount'), memberFollowersCount: z.number().int() }),
    z.object({ source: z.literal('networkSizes'), firstDegreeSize: z.number().int() }),
    unavailableRawSchema,
  ]),
});
export type LinkedInAccountMetricsRaw = z.infer<typeof linkedInAccountMetricsRawSchema>;

/** A count as the normalized metrics take it: a non-negative integer, else unknown. */
const countOf = (value: number | null | undefined): number | null =>
  value === null || value === undefined || value < 0 ? null : value;

const NO_METRICS: NormalizedPostMetrics = {
  impressions: null,
  reach: null,
  views: null,
  likes: null,
  comments: null,
  shares: null,
  clicks: null,
  saves: null,
};

/** Normalized counters from a raw post answer; throws when the answer has another shape. */
export function normalizeLinkedInPostMetrics(raw: unknown): NormalizedPostMetrics {
  const { linkedin } = linkedInPostMetricsRawSchema.parse(raw);
  switch (linkedin.source) {
    case 'memberCreatorPostAnalytics':
      return {
        ...NO_METRICS,
        impressions: countOf(linkedin.counts.IMPRESSION),
        reach: countOf(linkedin.counts.MEMBERS_REACHED),
        likes: countOf(linkedin.counts.REACTION),
        comments: countOf(linkedin.counts.COMMENT),
        shares: countOf(linkedin.counts.RESHARE),
      };
    case 'organizationalEntityShareStatistics': {
      // "Shares that are not returned in the list of elements can be assumed to have counts of 0
      // for all statistics."
      const stats = linkedin.totalShareStatistics ?? {
        impressionCount: 0,
        uniqueImpressionsCount: 0,
        clickCount: 0,
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
      };
      return {
        ...NO_METRICS,
        impressions: countOf(stats.impressionCount),
        reach: countOf(stats.uniqueImpressionsCount),
        // A negative likeCount is documented (sponsored unlikes); it counts as unknown.
        likes: countOf(stats.likeCount),
        comments: countOf(stats.commentCount),
        shares: countOf(stats.shareCount),
        clicks: countOf(stats.clickCount),
      };
    }
    case 'none':
      return { ...NO_METRICS };
  }
}

/** Normalized account numbers from a raw account answer. */
export function normalizeLinkedInAccountMetrics(raw: unknown): {
  followers: number | null;
  reach: number | null;
  profileViews: number | null;
} {
  const { linkedin } = linkedInAccountMetricsRawSchema.parse(raw);
  switch (linkedin.source) {
    case 'memberFollowersCount':
      return { followers: countOf(linkedin.memberFollowersCount), reach: null, profileViews: null };
    case 'networkSizes':
      return { followers: countOf(linkedin.firstDegreeSize), reach: null, profileViews: null };
    case 'none':
      return { followers: null, reach: null, profileViews: null };
  }
}
