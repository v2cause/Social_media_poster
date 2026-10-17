import type { NormalizedPostMetrics } from '@smp/core';
import type { XPostCounts } from '@smp/x-browser';

// The counters of the web app of X in the normalized metrics (architecture 8): its views are the
// impressions, replies the comments, reposts and quotes the shares, bookmarks the saves. Reach
// and clicks the web app does not show; they stay null, never 0.

/** Raised whenever the mapping changes, so old snapshots keep their meaning. */
export const X_BROWSER_MAP_VERSION = 1;

const sum = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

export function normalizeXBrowserPostMetrics(counts: XPostCounts): NormalizedPostMetrics {
  return {
    impressions: counts.views,
    reach: null,
    views: null,
    likes: counts.likes,
    comments: counts.replies,
    shares: sum(counts.reposts, counts.quotes),
    clicks: null,
    saves: counts.bookmarks,
  };
}
