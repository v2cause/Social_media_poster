import type { AnalyticsOverviewParams } from '@smp/api-client';
import {
  ANALYTICS_GRANULARITIES,
  ANALYTICS_MAX_PERIOD_DAYS,
  ANALYTICS_METRICS,
  ANALYTICS_TOP_SORTS,
  type AnalyticsMetric,
} from '@smp/contracts';
import { PLATFORMS, type Platform } from '@smp/platform-rules';
import { z } from 'zod';

import { addDays } from '@/features/publishing/zoned-time';

// The filters of the analytics views (guide step 5.5) in the query string: the last 7, 30 or 90
// days up to today in the time zone of the workspace, or a period of its own; platforms and
// accounts as comma-separated lists; the metric of the line chart, the comparison of the
// platforms, the order of the top posts and the breakdown. Each field falls back to its default
// when it is missing or invalid. The API checks the period against the history of the plan.

export const PERIOD_PRESETS = ['7', '30', '90'] as const;
const PERIODS = [...PERIOD_PRESETS, 'custom'] as const;
export type AnalyticsPeriodChoice = (typeof PERIODS)[number];
/** The period without a choice, like the API: the last 30 days. */
export const DEFAULT_PERIOD = '30' satisfies AnalyticsPeriodChoice;

/** What the bar chart compares between the platforms. */
export const COMPARE_METRICS = ['impressions', 'engagements', 'engagementRate', 'posts'] as const;
export type CompareMetric = (typeof COMPARE_METRICS)[number];

/** The breakdowns of the posts besides the platform. */
export const POST_BREAKDOWNS = ['style', 'weekday'] as const;

const none = z.literal('');
export const isPlatform = (value: string): value is Platform =>
  (PLATFORMS as readonly string[]).includes(value);

/** The ISO weekdays of the breakdown, Monday 1 to Sunday 7. */
const WEEKDAY_KEYS = ['1', '2', '3', '4', '5', '6', '7'] as const;
export const isWeekdayKey = (value: string): value is (typeof WEEKDAY_KEYS)[number] =>
  (WEEKDAY_KEYS as readonly string[]).includes(value);
const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;
/** A comma-separated list whose parts all pass the check; anything else is empty. */
const listOf = (check: (part: string) => boolean) =>
  z
    .string()
    .refine((value) => value.split(',').every(check))
    .catch('');

export const analyticsQuerySchema = z.object({
  period: z.enum(PERIODS).catch(DEFAULT_PERIOD),
  /** First and last day of a period of its own, YYYY-MM-DD. */
  from: z.union([z.iso.date(), none]).catch(''),
  to: z.union([z.iso.date(), none]).catch(''),
  platform: listOf(isPlatform),
  accountId: listOf(isUuid),
  metric: z.enum(ANALYTICS_METRICS).catch('impressions'),
  /** Empty: by day up to three months, by week beyond. */
  granularity: z.union([z.enum(ANALYTICS_GRANULARITIES), none]).catch(''),
  compare: z.enum(COMPARE_METRICS).catch('impressions'),
  sort: z.enum(ANALYTICS_TOP_SORTS).catch('engagements'),
  by: z.enum(POST_BREAKDOWNS).catch('style'),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

/** The parts of a list in the query string, each once. */
export const partsOf = (list: string): string[] => [
  ...new Set(list.split(',').filter((part) => part !== '')),
];

export const platformsOf = (query: Pick<AnalyticsQuery, 'platform'>): Platform[] =>
  partsOf(query.platform).filter(isPlatform);

export const accountIdsOf = (query: Pick<AnalyticsQuery, 'accountId'>): string[] => partsOf(query.accountId);

/** A list with one value more or one less, for the toggles of the filter bar. */
export function toggled(list: string, value: string, on: boolean): string {
  const parts = partsOf(list).filter((part) => part !== value);
  return (on ? [...parts, value] : parts).join(',');
}

export type PeriodProblem = 'incomplete' | 'inverted' | 'too_long';

export interface Period {
  from: string;
  to: string;
}

const lengthOf = (period: Period): number =>
  Math.round((Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / 86_400_000) +
  1;

/** The period of the query, `today` being the local day of the workspace, or why there is none. */
export function periodOf(
  query: Pick<AnalyticsQuery, 'period' | 'from' | 'to'>,
  today: string,
): { period: Period; problem: null } | { period: null; problem: PeriodProblem } {
  if (query.period !== 'custom') {
    return { period: { from: addDays(today, 1 - Number(query.period)), to: today }, problem: null };
  }
  if (query.from === '' || query.to === '') {
    return { period: null, problem: 'incomplete' };
  }
  if (query.to < query.from) {
    return { period: null, problem: 'inverted' };
  }
  const period = { from: query.from, to: query.to };
  return lengthOf(period) > ANALYTICS_MAX_PERIOD_DAYS
    ? { period: null, problem: 'too_long' }
    : { period, problem: null };
}

/** The days of a period. */
export const periodLengthOf = lengthOf;

/** The query of the overview, the breakdowns, the top posts and the export. */
export function filterParamsOf(query: AnalyticsQuery, period: Period): AnalyticsOverviewParams {
  const platforms = platformsOf(query);
  const accounts = accountIdsOf(query);
  return {
    from: period.from,
    to: period.to,
    ...(platforms.length > 0 ? { platform: platforms.join(',') } : {}),
    ...(accounts.length > 0 ? { accountId: accounts.join(',') } : {}),
  };
}

/** The buckets of the line chart: as chosen, or by day up to three months and by week beyond. */
export const granularityOf = (
  query: Pick<AnalyticsQuery, 'granularity'>,
  period: Period,
): (typeof ANALYTICS_GRANULARITIES)[number] =>
  query.granularity === '' ? (lengthOf(period) <= 92 ? 'day' : 'week') : query.granularity;

/** Metrics that are rates; their change is shown in percentage points. */
export const isRateMetric = (metric: AnalyticsMetric | CompareMetric): boolean => metric === 'engagementRate';
