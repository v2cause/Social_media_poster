import type { Platform } from '@smp/platform-rules';

import { localDayOf } from './days';
import { engagementRateOf, impressionsOf, sumOf } from './kpis';

// The breakdowns of guide step 5.4 from the latest numbers of the posts of a period: per
// platform, per post style and per weekday of publication in the time zone of the workspace.

export type BreakdownBy = 'platform' | 'style' | 'weekday';

export interface BreakdownPost {
  platform: Platform;
  publishedAt: Date;
  style: { id: string; key: string; name: string; preset: boolean } | null;
  metrics: {
    impressions: number | null;
    reach: number | null;
    views: number | null;
    engagements: number | null;
  } | null;
}

export interface BreakdownGroup {
  /** The platform, the style id ("none" without a style), or the ISO weekday 1 (Monday) to 7. */
  key: string;
  /** The key of a preset style or the name of a custom one. */
  label: string | null;
  preset: boolean | null;
  posts: number;
  impressions: number | null;
  engagements: number | null;
  engagementRate: number | null;
}

/** The ISO weekday of a local day: 1 for Monday to 7 for Sunday. */
export const isoWeekdayOf = (day: string): number => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
};

const keyOf = (post: BreakdownPost, by: BreakdownBy, timeZone: string): string => {
  switch (by) {
    case 'platform':
      return post.platform;
    case 'style':
      return post.style?.id ?? 'none';
    case 'weekday':
      return String(isoWeekdayOf(localDayOf(post.publishedAt, timeZone)));
  }
};

/**
 * The groups of the posts: every weekday in order, platforms and styles by the number of their
 * posts. A post without numbers counts as published, with metrics that are not reported.
 */
export function breakdownOf(
  posts: readonly BreakdownPost[],
  by: BreakdownBy,
  timeZone: string,
): BreakdownGroup[] {
  const groups = new Map<string, BreakdownPost[]>();
  if (by === 'weekday') {
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      groups.set(String(weekday), []);
    }
  }
  for (const post of posts) {
    const key = keyOf(post, by, timeZone);
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }
  const result = [...groups].map(([key, members]): BreakdownGroup => {
    const metrics = members.flatMap((post) => (post.metrics ? [post.metrics] : []));
    const style = by === 'style' ? (members[0]?.style ?? null) : null;
    return {
      key,
      label: style ? (style.preset ? style.key : style.name) : null,
      preset: by === 'style' ? (style?.preset ?? null) : null,
      posts: members.length,
      impressions: sumOf(metrics.map(impressionsOf)),
      engagements: sumOf(metrics.map((entry) => entry.engagements)),
      engagementRate: engagementRateOf(metrics),
    };
  });
  return by === 'weekday' ? result : result.sort((a, b) => b.posts - a.posts || a.key.localeCompare(b.key));
}
