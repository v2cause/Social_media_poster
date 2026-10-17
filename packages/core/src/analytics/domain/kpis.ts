import type { Platform } from '@smp/platform-rules';

import { nextDay } from './days';

// The KPIs of architecture 8 from the rollup per account and day (guide step 5.4). A metric no
// account reports stays null; the reach of an account wins over the sum of the reach of its
// posts, which overlaps; rates are computed here once, the same for every view.

export interface DailyMetrics {
  accountId: string;
  platform: Platform;
  /** The local day of the workspace, YYYY-MM-DD. */
  day: string;
  impressions: number | null;
  postReach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
  engagements: number | null;
  postsPublished: number;
  followers: number | null;
  accountReach: number | null;
  profileViews: number | null;
}

/** Where a reach comes from: the accounts, the sum of the post reaches, or both. */
export type ReachBasis = 'account' | 'posts' | 'mixed';

export type Granularity = 'day' | 'week' | 'month';

export type TimeseriesMetric =
  | 'impressions'
  | 'reach'
  | 'views'
  | 'engagements'
  | 'engagementRate'
  | 'likes'
  | 'comments'
  | 'shares'
  | 'clicks'
  | 'saves'
  | 'followers'
  | 'postsPublished'
  | 'profileViews';

/** The sum of the reported values; null when none is reported. */
export function sumOf(values: readonly (number | null)[]): number | null {
  let sum: number | null = null;
  for (const value of values) {
    if (value !== null) {
      sum = (sum ?? 0) + value;
    }
  }
  return sum;
}

/** The base of a rate: impressions, else views, else reach (architecture 8). */
interface RateInput {
  engagements: number | null;
  impressions: number | null;
  views: number | null;
  reach: number | null;
}

/**
 * engagements / (impressions ?? views ?? reach), taken per entry so a platform without
 * impressions brings its views; null without a base above 0.
 */
export function engagementRateOf(entries: readonly RateInput[]): number | null {
  let engagements = 0;
  let base = 0;
  for (const entry of entries) {
    const entryBase = entry.impressions ?? entry.views ?? entry.reach;
    if (entryBase !== null && entry.engagements !== null) {
      engagements += entry.engagements;
      base += entryBase;
    }
  }
  return base > 0 ? engagements / base : null;
}

const rateInputOf = (row: DailyMetrics): RateInput => ({
  engagements: row.engagements,
  impressions: row.impressions,
  views: row.views,
  reach: row.postReach,
});

/** The engagement rate of rollup rows. */
export const dailyEngagementRateOf = (rows: readonly DailyMetrics[]): number | null =>
  engagementRateOf(rows.map(rateInputOf));

const byAccount = (rows: readonly DailyMetrics[]): Map<string, DailyMetrics[]> => {
  const accounts = new Map<string, DailyMetrics[]>();
  for (const row of rows) {
    accounts.set(row.accountId, [...(accounts.get(row.accountId) ?? []), row]);
  }
  for (const list of accounts.values()) {
    list.sort((a, b) => a.day.localeCompare(b.day));
  }
  return accounts;
};

/** The reach: per account its own reach where it reports one, else the sum of its post reaches. */
export function reachOf(rows: readonly DailyMetrics[]): { value: number | null; basis: ReachBasis | null } {
  let value: number | null = null;
  const bases = new Set<'account' | 'posts'>();
  for (const list of byAccount(rows).values()) {
    const own = sumOf(list.map((row) => row.accountReach));
    const posts = sumOf(list.map((row) => row.postReach));
    if (own !== null) {
      value = (value ?? 0) + own;
      bases.add('account');
    } else if (posts !== null) {
      value = (value ?? 0) + posts;
      bases.add('posts');
    }
  }
  const basis: ReachBasis | null = bases.size === 2 ? 'mixed' : ([...bases][0] ?? null);
  return { value, basis };
}

/**
 * What the followers grew: per account its last count in the rows minus its last count before
 * them (the baseline), or its first count in the rows without a baseline.
 */
export function followerGrowthOf(
  rows: readonly DailyMetrics[],
  baselines: ReadonlyMap<string, number>,
): number | null {
  let growth: number | null = null;
  for (const [accountId, list] of byAccount(rows)) {
    const counts = list.flatMap((row) => (row.followers === null ? [] : [row.followers]));
    const end = counts.at(-1);
    const start = baselines.get(accountId) ?? counts[0];
    if (end !== undefined && start !== undefined) {
      growth = (growth ?? 0) + end - start;
    }
  }
  return growth;
}

/** The days from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = nextDay(day)) {
    days.push(day);
  }
  return days;
}

/** The first day of the bucket of a day: itself, the Monday of its week, the first of its month. */
export function bucketOf(day: string, granularity: Granularity): string {
  if (granularity === 'day') {
    return day;
  }
  if (granularity === 'month') {
    return `${day.slice(0, 7)}-01`;
  }
  const date = new Date(`${day}T00:00:00Z`);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - sinceMonday * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The total followers of the accounts at the end of each day: each account keeps its last count
 * (from its baseline on) until a new one comes; null on days no account has a count yet.
 */
export function followersByDay(
  rows: readonly DailyMetrics[],
  days: readonly string[],
  baselines: ReadonlyMap<string, number>,
): (number | null)[] {
  const accounts = byAccount(rows);
  const last = new Map<string, number>();
  for (const accountId of accounts.keys()) {
    const baseline = baselines.get(accountId);
    if (baseline !== undefined) {
      last.set(accountId, baseline);
    }
  }
  const counts = new Map<string, Map<string, number>>();
  for (const [accountId, list] of accounts) {
    counts.set(
      accountId,
      new Map(list.flatMap((row) => (row.followers === null ? [] : [[row.day, row.followers] as const]))),
    );
  }
  return days.map((day) => {
    for (const [accountId, byDay] of counts) {
      const count = byDay.get(day);
      if (count !== undefined) {
        last.set(accountId, count);
      }
    }
    return last.size === 0 ? null : [...last.values()].reduce((sum, count) => sum + count, 0);
  });
}

/**
 * The impressions of a row: Facebook and Instagram report views in their place (architecture 8),
 * so views count where impressions are missing.
 */
export const impressionsOf = (entry: { impressions: number | null; views: number | null }): number | null =>
  entry.impressions ?? entry.views;

const ADDITIVE: Partial<Record<TimeseriesMetric, keyof DailyMetrics>> = {
  views: 'views',
  engagements: 'engagements',
  likes: 'likes',
  comments: 'comments',
  shares: 'shares',
  clicks: 'clicks',
  saves: 'saves',
  profileViews: 'profileViews',
};

/** A metric of the rows of one bucket; followers are taken per day with followersByDay. */
export function metricOf(
  rows: readonly DailyMetrics[],
  metric: Exclude<TimeseriesMetric, 'followers'>,
): number | null {
  switch (metric) {
    case 'reach':
      return reachOf(rows).value;
    case 'engagementRate':
      return dailyEngagementRateOf(rows);
    case 'postsPublished':
      return rows.reduce((sum, row) => sum + row.postsPublished, 0);
    case 'impressions':
      return sumOf(rows.map(impressionsOf));
    default: {
      const key = ADDITIVE[metric];
      return key ? sumOf(rows.map((row) => row[key] as number | null)) : null;
    }
  }
}

/** One value per bucket for the rows of a group; followers at the last day of each bucket. */
export function seriesOf(
  rows: readonly DailyMetrics[],
  metric: TimeseriesMetric,
  days: readonly string[],
  granularity: Granularity,
  baselines: ReadonlyMap<string, number>,
): { buckets: string[]; values: (number | null)[] } {
  const buckets = [...new Set(days.map((day) => bucketOf(day, granularity)))];
  if (metric === 'followers') {
    const daily = followersByDay(rows, days, baselines);
    const lastOfBucket = new Map<string, number | null>();
    days.forEach((day, index) => lastOfBucket.set(bucketOf(day, granularity), daily[index] ?? null));
    return { buckets, values: buckets.map((bucket) => lastOfBucket.get(bucket) ?? null) };
  }
  const rowsOf = new Map<string, DailyMetrics[]>();
  for (const row of rows) {
    const bucket = bucketOf(row.day, granularity);
    rowsOf.set(bucket, [...(rowsOf.get(bucket) ?? []), row]);
  }
  return { buckets, values: buckets.map((bucket) => metricOf(rowsOf.get(bucket) ?? [], metric)) };
}
