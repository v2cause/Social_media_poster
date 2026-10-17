import type { NormalizedPostMetrics } from '@smp/core';
import { z } from 'zod';

// The normalization of the mock platforms (guide step 5.2, architecture 8). Like the mapping of a
// real adapter in src/<platform>/metrics-map.ts, it turns the raw answer, which the snapshot
// keeps, into the normalized counters; MAP_VERSION is raised whenever the mapping changes, so
// the snapshots of older versions can be computed again from their raw answers.

export const MAP_VERSION = 1;

const count = z.number().int().nonnegative().nullable();

/** The raw post answer of the mock platforms: its counters under "mock". */
export const mockPostMetricsRawSchema = z.object({
  mock: z.object({
    impressions: count,
    reach: count,
    views: count,
    likes: count,
    comments: count,
    shares: count,
    clicks: count,
    saves: count,
  }),
});

/** The raw account answer of the mock platforms. */
export const mockAccountMetricsRawSchema = z.object({
  mock: z.object({ followers: count, reach: count, profileViews: count }),
});

/** Normalized counters from a raw post answer; throws when the answer has another shape. */
export function normalizeMockPostMetrics(raw: unknown): NormalizedPostMetrics {
  const { mock } = mockPostMetricsRawSchema.parse(raw);
  return { ...mock };
}

/** Normalized account numbers from a raw account answer. */
export function normalizeMockAccountMetrics(raw: unknown): {
  followers: number | null;
  reach: number | null;
  profileViews: number | null;
} {
  const { mock } = mockAccountMetricsRawSchema.parse(raw);
  return { ...mock };
}
