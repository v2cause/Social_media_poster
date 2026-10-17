import { z } from 'zod';

import { socialAccountTypeSchema } from './channels';
import { platformSchema } from './content';

// Requests and responses of the analytics API (guide step 5.4, architecture 8). Days are local
// days of the workspace (YYYY-MM-DD). A metric no platform reports is null, never 0, so the UI
// can tell "n. v." from nothing; rates come from the server.

const day = z.iso.date();
const id = z.uuid();
/** A count, or null where the platforms report nothing; growth between polls can be negative. */
const count = z.number().int().nullable();
const rate = z.number().nullable();

/** The longest period one request may ask for. */
export const ANALYTICS_MAX_PERIOD_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysOf = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;

/** A comma-separated list, for example LINKEDIN,X. */
const split = (value: string): string[] => value.split(',').filter((part) => part.length > 0);
const platformList = z.string().max(100).transform(split).pipe(z.array(platformSchema).min(1).max(4));
const accountList = z.string().max(4_000).transform(split).pipe(z.array(id).min(1).max(100));

/** The filters every analytics request shares. Without from and to: the last 30 days. */
const filterShape = {
  from: day.optional(),
  to: day.optional(),
  platform: platformList.optional(),
  accountId: accountList.optional(),
};

const checkPeriod = (
  query: { from?: string | undefined; to?: string | undefined },
  ctx: z.RefinementCtx,
): void => {
  if (query.from && query.to) {
    if (query.from > query.to) {
      ctx.addIssue({ code: 'custom', message: 'from_after_to', path: ['from'] });
    } else if (daysOf(query.from, query.to) > ANALYTICS_MAX_PERIOD_DAYS) {
      ctx.addIssue({ code: 'custom', message: 'period_too_long', path: ['from'] });
    }
  }
};

export const analyticsFilterSchema = z.object(filterShape).superRefine(checkPeriod);
export type AnalyticsFilter = z.input<typeof analyticsFilterSchema>;

const periodSchema = z.object({ from: day, to: day });

// --- Overview --------------------------------------------------------------------------------

/** A KPI of the period and of the period of the same length before it. */
const kpiSchema = z.object({ value: rate, previous: rate });

/** Where the reach comes from: the accounts, the sum of the post reaches, or both. */
export const REACH_BASES = ['account', 'posts', 'mixed'] as const;

export const analyticsOverviewSchema = z.object({
  period: periodSchema,
  /** Null when the history of the plan does not reach back that far. */
  previous: periodSchema.nullable(),
  kpis: z.object({
    impressions: kpiSchema,
    reach: kpiSchema.extend({ basis: z.enum(REACH_BASES).nullable() }),
    engagements: kpiSchema,
    engagementRate: kpiSchema,
    followerGrowth: kpiSchema,
    postsPublished: kpiSchema,
  }),
  /** One value per day of the period, for the sparklines. */
  series: z.object({
    days: z.array(day),
    impressions: z.array(rate),
    reach: z.array(rate),
    engagements: z.array(rate),
    engagementRate: z.array(rate),
    followers: z.array(rate),
    postsPublished: z.array(rate),
  }),
  /** The first day the plan keeps. */
  historyFrom: day,
});
export type AnalyticsOverviewDto = z.infer<typeof analyticsOverviewSchema>;

// --- Time series -----------------------------------------------------------------------------

export const ANALYTICS_METRICS = [
  'impressions',
  'reach',
  'views',
  'engagements',
  'engagementRate',
  'likes',
  'comments',
  'shares',
  'clicks',
  'saves',
  'followers',
  'postsPublished',
  'profileViews',
] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

export const ANALYTICS_GRANULARITIES = ['day', 'week', 'month'] as const;
export const ANALYTICS_GROUPS = ['platform', 'account', 'total'] as const;

export const analyticsTimeseriesQuerySchema = z
  .object({
    ...filterShape,
    metric: z.enum(ANALYTICS_METRICS).default('impressions'),
    granularity: z.enum(ANALYTICS_GRANULARITIES).default('day'),
    groupBy: z.enum(ANALYTICS_GROUPS).default('platform'),
  })
  .superRefine(checkPeriod);
export type AnalyticsTimeseriesQuery = z.input<typeof analyticsTimeseriesQuerySchema>;

export const analyticsTimeseriesSchema = z.object({
  period: periodSchema,
  metric: z.enum(ANALYTICS_METRICS),
  granularity: z.enum(ANALYTICS_GRANULARITIES),
  groupBy: z.enum(ANALYTICS_GROUPS),
  /** The first day of each bucket: the day, the Monday of the week, the first of the month. */
  buckets: z.array(day),
  series: z.array(
    z.object({
      /** The platform, the account id, or "total". */
      key: z.string(),
      platform: platformSchema.nullable(),
      /** The name of the account when grouped by account. */
      label: z.string().nullable(),
      values: z.array(rate),
    }),
  ),
});
export type AnalyticsTimeseriesDto = z.infer<typeof analyticsTimeseriesSchema>;

// --- Posts -----------------------------------------------------------------------------------

const postMetricsSchema = z.object({
  impressions: count,
  reach: count,
  views: count,
  likes: count,
  comments: count,
  shares: count,
  clicks: count,
  saves: count,
  engagements: count,
});

export const analyticsPostSchema = z.object({
  variantId: id,
  postId: id,
  platform: platformSchema,
  account: z.object({ id, name: z.string(), handle: z.string().nullable() }).nullable(),
  preview: z.string(),
  publishedAt: z.iso.datetime(),
  externalUrl: z.string().nullable(),
  /** The platform no longer knows the post. */
  externalDeletedAt: z.iso.datetime().nullable(),
  /** A preset is named by its key, a custom style by its name. */
  style: z.object({ id, key: z.string(), name: z.string(), preset: z.boolean() }).nullable(),
  metrics: postMetricsSchema.nullable(),
  engagementRate: rate,
  capturedAt: z.iso.datetime().nullable(),
});
export type AnalyticsPostDto = z.infer<typeof analyticsPostSchema>;

export const ANALYTICS_TOP_SORTS = ['engagements', 'engagementRate', 'impressions'] as const;

export const analyticsTopPostsQuerySchema = z
  .object({
    ...filterShape,
    sort: z.enum(ANALYTICS_TOP_SORTS).default('engagements'),
    limit: z.coerce.number().int().min(1).max(50).default(10),
    /** Posts seen less often stay out, so a rate of one view does not top the list. */
    minImpressions: z.coerce.number().int().min(0).max(1_000_000_000).default(100),
  })
  .superRefine(checkPeriod);
export type AnalyticsTopPostsQuery = z.input<typeof analyticsTopPostsQuerySchema>;

export const analyticsTopPostsSchema = z.object({
  period: periodSchema,
  items: z.array(analyticsPostSchema),
});
export type AnalyticsTopPostsDto = z.infer<typeof analyticsTopPostsSchema>;

export const analyticsPostDetailSchema = analyticsPostSchema.extend({
  snapshots: z.array(
    z.object({
      capturedAt: z.iso.datetime(),
      /** The step of the polling cascade; null for a manual refresh. */
      step: z.number().int().nullable(),
      metrics: postMetricsSchema,
    }),
  ),
});
export type AnalyticsPostDetailDto = z.infer<typeof analyticsPostDetailSchema>;

// --- Breakdown -------------------------------------------------------------------------------

export const ANALYTICS_BREAKDOWNS = ['platform', 'style', 'weekday'] as const;

export const analyticsBreakdownQuerySchema = z
  .object({ ...filterShape, by: z.enum(ANALYTICS_BREAKDOWNS) })
  .superRefine(checkPeriod);
export type AnalyticsBreakdownQuery = z.input<typeof analyticsBreakdownQuerySchema>;

export const analyticsBreakdownSchema = z.object({
  period: periodSchema,
  by: z.enum(ANALYTICS_BREAKDOWNS),
  groups: z.array(
    z.object({
      /** The platform, the style id ("none" without a style), or the ISO weekday 1 (Monday) to 7. */
      key: z.string(),
      /** The key of a preset style or the name of a custom one. */
      label: z.string().nullable(),
      preset: z.boolean().nullable(),
      posts: z.number().int(),
      impressions: count,
      engagements: count,
      engagementRate: rate,
    }),
  ),
});
export type AnalyticsBreakdownDto = z.infer<typeof analyticsBreakdownSchema>;

// --- Account ---------------------------------------------------------------------------------

export const analyticsPeriodQuerySchema = z
  .object({ from: filterShape.from, to: filterShape.to })
  .superRefine(checkPeriod);
export type AnalyticsPeriodQuery = z.input<typeof analyticsPeriodQuerySchema>;

export const analyticsAccountSchema = z.object({
  account: z.object({
    id,
    name: z.string(),
    handle: z.string().nullable(),
    platform: platformSchema,
    type: socialAccountTypeSchema,
    disconnectedAt: z.iso.datetime().nullable(),
  }),
  period: periodSchema,
  days: z.array(
    z.object({
      day,
      followers: count,
      accountReach: count,
      profileViews: count,
      impressions: count,
      engagements: count,
      postsPublished: z.number().int(),
    }),
  ),
});
export type AnalyticsAccountDto = z.infer<typeof analyticsAccountSchema>;
