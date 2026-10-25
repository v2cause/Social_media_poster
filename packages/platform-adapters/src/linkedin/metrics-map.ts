import type { NormalizedPostMetrics } from '@smp/core';
import { z } from 'zod';

// The normalization of LinkedIn (guide step 5.2, architecture 8): company pages report share
// statistics, personal posts the metric types of Member Post Analytics. The raw answer stays with
// the snapshot; MAP_VERSION rises whenever this mapping changes.

export const LINKEDIN_MAP_VERSION = 1;

const count = z.number().int().nonnegative().nullable().optional();

export const shareStatisticsSchema = z
  .object({
    impressionCount: count,
    uniqueImpressionsCount: count,
    clickCount: count,
    likeCount: count,
    commentCount: count,
    shareCount: count,
  })
  .loose();

/** The metric types of Member Post Analytics the adapter asks for. */
export const MEMBER_METRIC_TYPES = [
  'IMPRESSION',
  'MEMBERS_REACHED',
  'REACTION',
  'COMMENT',
  'RESHARE',
] as const;

export const linkedInPostRawSchema = z.object({
  linkedin: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('organization'), totalShareStatistics: shareStatisticsSchema }),
    z.object({
      kind: z.literal('member'),
      counts: z.partialRecord(z.enum(MEMBER_METRIC_TYPES), z.number().int().nonnegative()),
    }),
    // A personal post without Member Post Analytics: LinkedIn reports nothing.
    z.object({ kind: z.literal('none') }),
  ]),
});
export type LinkedInPostRaw = z.infer<typeof linkedInPostRawSchema>;

export const linkedInAccountRawSchema = z.object({
  linkedin: z.object({ followers: z.number().int().nonnegative().nullable() }),
});

const orNull = (value: number | null | undefined): number | null => value ?? null;

export function normalizeLinkedInPostMetrics(raw: unknown): NormalizedPostMetrics {
  const { linkedin } = linkedInPostRawSchema.parse(raw);
  const none: NormalizedPostMetrics = {
    impressions: null,
    reach: null,
    views: null,
    likes: null,
    comments: null,
    shares: null,
    clicks: null,
    saves: null,
  };
  switch (linkedin.kind) {
    case 'organization': {
      const stats = linkedin.totalShareStatistics;
      return {
        ...none,
        impressions: orNull(stats.impressionCount),
        reach: orNull(stats.uniqueImpressionsCount),
        likes: orNull(stats.likeCount),
        comments: orNull(stats.commentCount),
        shares: orNull(stats.shareCount),
        clicks: orNull(stats.clickCount),
      };
    }
    case 'member':
      return {
        ...none,
        impressions: orNull(linkedin.counts.IMPRESSION),
        reach: orNull(linkedin.counts.MEMBERS_REACHED),
        likes: orNull(linkedin.counts.REACTION),
        comments: orNull(linkedin.counts.COMMENT),
        shares: orNull(linkedin.counts.RESHARE),
      };
    case 'none':
      return none;
  }
}

export function normalizeLinkedInAccountMetrics(raw: unknown): {
  followers: number | null;
  reach: number | null;
  profileViews: number | null;
} {
  const { linkedin } = linkedInAccountRawSchema.parse(raw);
  return { followers: linkedin.followers, reach: null, profileViews: null };
}
