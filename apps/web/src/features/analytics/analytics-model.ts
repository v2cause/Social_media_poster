import type { AnalyticsOverviewDto } from '@smp/contracts';

// The numbers of the analytics views without a browser (guide step 5.5): the change of a KPI
// against the period before, and whether a period has any data. Null means the platforms report
// nothing ("n. v."); it never counts as 0.

export type Change =
  /** No comparison: one of the periods has no value, or the period before was 0. */
  | { kind: 'none' }
  /** A count: the relative change, 0.12 for 12 percent more. */
  | { kind: 'ratio'; ratio: number; direction: Direction }
  /** A rate: the difference in percentage points. */
  | { kind: 'points'; points: number; direction: Direction };

export type Direction = 'up' | 'down' | 'flat';

/** Below this the change shows as flat: 0.05 percent, or 0.005 percentage points. */
const FLAT_RATIO = 0.0005;
const FLAT_POINTS = 0.005;

const directionOf = (delta: number, flat: number): Direction =>
  Math.abs(delta) < flat ? 'flat' : delta > 0 ? 'up' : 'down';

/** The change of a value against the one of the period before. */
export function changeOf(value: number | null, previous: number | null, kind: 'count' | 'rate'): Change {
  if (value === null || previous === null) {
    return { kind: 'none' };
  }
  if (kind === 'rate') {
    const points = (value - previous) * 100;
    return { kind: 'points', points, direction: directionOf(points, FLAT_POINTS) };
  }
  if (previous === 0) {
    return value === 0 ? { kind: 'ratio', ratio: 0, direction: 'flat' } : { kind: 'none' };
  }
  // Growth can be negative, so the change relates to the size of the value before.
  const ratio = (value - previous) / Math.abs(previous);
  return { kind: 'ratio', ratio, direction: directionOf(ratio, FLAT_RATIO) };
}

/** True when not a single day of the period has a number other than 0. */
export function isEmptyOverview(overview: Pick<AnalyticsOverviewDto, 'series'>): boolean {
  const { impressions, reach, engagements, engagementRate, followers, postsPublished } = overview.series;
  return [impressions, reach, engagements, engagementRate, followers, postsPublished].every((values) =>
    values.every((value) => value === null || value === 0),
  );
}

/** The largest value of a list, ignoring the gaps; null when there is none. */
export function maxOf(values: readonly (number | null)[]): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (value !== null && (max === null || value > max)) {
      max = value;
    }
  }
  return max;
}
