import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AnalyticsAccountDto,
  AnalyticsBreakdownDto,
  AnalyticsOverviewDto,
  AnalyticsPostDetailDto,
  AnalyticsPostDto,
  AnalyticsTimeseriesDto,
  AnalyticsTopPostsDto,
} from '@smp/contracts';
import {
  breakdownOf,
  dailyEngagementRateOf,
  daysBetween,
  engagementRateOf,
  engagementsOf,
  followerGrowthOf,
  followersByDay,
  localDayRange,
  metricOf,
  reachOf,
  resolveAnalyticsPeriod,
  seriesOf,
  SocialAccountNotFoundError,
  sumOf,
  systemClock,
  VariantNotFoundError,
  type AnalyticsHistory,
  type AnalyticsPeriod,
  type BreakdownBy,
  type DailyMetrics,
  type Granularity,
  type TimeseriesMetric,
} from '@smp/core';
import type {
  AnalyticsFilter,
  AnalyticsPostView,
  AnalyticsReadModel,
  PostPeriodFilter,
  TopPostsSort,
  WorkspaceRef,
} from '@smp/db';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../../infrastructure/clients.module';
import { ANALYTICS_HISTORY, ANALYTICS_READ_MODEL } from './analytics.tokens';

// The analytics of a workspace (guide step 5.4): the KPIs of a period against the period before,
// series per platform or account, top posts, breakdowns, a post with its snapshots and an
// account. The numbers come from the rollup and the latest snapshots; every rate and every
// derived value comes from the functions of the core, so all views agree. The overview is kept
// in Redis for 5 minutes.

/** How long an overview stays in Redis. */
const OVERVIEW_TTL_SECONDS = 5 * 60;

export interface AnalyticsSelection {
  from?: string | undefined;
  to?: string | undefined;
  platform?: AnalyticsFilter['platforms'] | undefined;
  accountId?: readonly string[] | undefined;
}

const filterOf = (selection: AnalyticsSelection): Pick<AnalyticsFilter, 'platforms' | 'accountIds'> => ({
  ...(selection.platform ? { platforms: selection.platform } : {}),
  ...(selection.accountId ? { accountIds: selection.accountId } : {}),
});

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function toPostDto(view: AnalyticsPostView): AnalyticsPostDto {
  const metrics = view.metrics ? { ...view.metrics, engagements: view.metrics.engagements } : null;
  return {
    variantId: view.variantId,
    postId: view.postId,
    platform: view.platform,
    account: view.account,
    preview: view.preview,
    publishedAt: view.publishedAt.toISOString(),
    externalUrl: view.externalUrl,
    externalDeletedAt: iso(view.externalDeletedAt),
    style: view.style,
    metrics,
    engagementRate: metrics ? engagementRateOf([metrics]) : null,
    capturedAt: iso(view.capturedAt),
  };
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @Inject(ANALYTICS_READ_MODEL) private readonly readModel: AnalyticsReadModel,
    @Inject(ANALYTICS_HISTORY) private readonly history: AnalyticsHistory,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** The period asked for in the time zone of the workspace, checked against the history. */
  async periodOf(
    ref: WorkspaceRef,
    selection: AnalyticsSelection,
  ): Promise<{ period: AnalyticsPeriod; timeZone: string }> {
    const timeZone = await this.readModel.timeZoneOf(ref);
    const period = await resolveAnalyticsPeriod(
      { history: this.history, clock: systemClock },
      { organizationId: ref.organizationId, timeZone },
      selection,
    );
    return { period, timeZone };
  }

  async overview(ref: WorkspaceRef, selection: AnalyticsSelection): Promise<AnalyticsOverviewDto> {
    const { period } = await this.periodOf(ref, selection);
    const filter = filterOf(selection);
    const key = `analytics:overview:${ref.workspaceId}:${createHash('sha256')
      .update(JSON.stringify({ from: period.from, to: period.to, ...filter }))
      .digest('hex')
      .slice(0, 32)}`;
    const cached = await this.cached(key);
    if (cached) {
      return cached;
    }
    const [rows, baselines, previousRows, previousBaselines] = await Promise.all([
      this.readModel.daily(ref, { from: period.from, to: period.to, ...filter }),
      this.readModel.followerBaselines(ref, period.from, filter),
      period.previous
        ? this.readModel.daily(ref, { from: period.previous.from, to: period.previous.to, ...filter })
        : Promise.resolve(null),
      period.previous
        ? this.readModel.followerBaselines(ref, period.previous.from, filter)
        : Promise.resolve(null),
    ]);
    const kpi = (value: (rows: DailyMetrics[], baselines: Map<string, number>) => number | null) => ({
      value: value(rows, baselines),
      previous: previousRows && previousBaselines ? value(previousRows, previousBaselines) : null,
    });
    const reach = reachOf(rows);
    const days = daysBetween(period.from, period.to);
    const rowsOfDay = new Map<string, DailyMetrics[]>();
    for (const row of rows) {
      rowsOfDay.set(row.day, [...(rowsOfDay.get(row.day) ?? []), row]);
    }
    const daily = (metric: Exclude<TimeseriesMetric, 'followers'>) =>
      days.map((day) => metricOf(rowsOfDay.get(day) ?? [], metric));
    const overview: AnalyticsOverviewDto = {
      period: { from: period.from, to: period.to },
      previous: period.previous,
      kpis: {
        impressions: kpi((list) => metricOf(list, 'impressions')),
        reach: { ...kpi((list) => reachOf(list).value), basis: reach.basis },
        engagements: kpi((list) => sumOf(list.map((row) => row.engagements))),
        engagementRate: kpi((list) => dailyEngagementRateOf(list)),
        followerGrowth: kpi((list, base) => followerGrowthOf(list, base)),
        postsPublished: kpi((list) => metricOf(list, 'postsPublished')),
      },
      series: {
        days,
        impressions: daily('impressions'),
        reach: daily('reach'),
        engagements: daily('engagements'),
        engagementRate: daily('engagementRate'),
        followers: followersByDay(rows, days, baselines),
        postsPublished: daily('postsPublished'),
      },
      historyFrom: period.historyFrom,
    };
    await this.cache(key, overview);
    return overview;
  }

  async timeseries(
    ref: WorkspaceRef,
    selection: AnalyticsSelection & {
      metric: TimeseriesMetric;
      granularity: Granularity;
      groupBy: 'platform' | 'account' | 'total';
    },
  ): Promise<AnalyticsTimeseriesDto> {
    const { period } = await this.periodOf(ref, selection);
    const filter = filterOf(selection);
    const [rows, baselines, names] = await Promise.all([
      this.readModel.daily(ref, { from: period.from, to: period.to, ...filter }),
      selection.metric === 'followers'
        ? this.readModel.followerBaselines(ref, period.from, filter)
        : Promise.resolve(new Map<string, number>()),
      selection.groupBy === 'account'
        ? this.readModel.accountNames(ref)
        : Promise.resolve(new Map<string, string>()),
    ]);
    const days = daysBetween(period.from, period.to);
    const groups = new Map<string, DailyMetrics[]>();
    for (const row of rows) {
      const key =
        selection.groupBy === 'platform'
          ? row.platform
          : selection.groupBy === 'account'
            ? row.accountId
            : 'total';
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const { buckets } = seriesOf([], selection.metric, days, selection.granularity, baselines);
    return {
      period: { from: period.from, to: period.to },
      metric: selection.metric,
      granularity: selection.granularity,
      groupBy: selection.groupBy,
      buckets,
      series: [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, list]) => ({
          key,
          platform: selection.groupBy === 'total' ? null : (list[0]?.platform ?? null),
          label: selection.groupBy === 'account' ? (names.get(key) ?? null) : null,
          values: seriesOf(list, selection.metric, days, selection.granularity, baselines).values,
        })),
    };
  }

  async topPosts(
    ref: WorkspaceRef,
    selection: AnalyticsSelection & { sort: TopPostsSort; limit: number; minImpressions: number },
  ): Promise<AnalyticsTopPostsDto> {
    const { period, timeZone } = await this.periodOf(ref, selection);
    const posts = await this.readModel.topPosts(ref, this.postPeriod(period, timeZone, selection), {
      sort: selection.sort,
      limit: selection.limit,
      minImpressions: selection.minImpressions,
    });
    return { period: { from: period.from, to: period.to }, items: posts.map(toPostDto) };
  }

  async breakdown(
    ref: WorkspaceRef,
    selection: AnalyticsSelection & { by: BreakdownBy },
  ): Promise<AnalyticsBreakdownDto> {
    const { period, timeZone } = await this.periodOf(ref, selection);
    const posts = await this.readModel.postsOfPeriod(ref, this.postPeriod(period, timeZone, selection));
    return {
      period: { from: period.from, to: period.to },
      by: selection.by,
      groups: breakdownOf(posts, selection.by, timeZone),
    };
  }

  async post(ref: WorkspaceRef, variantId: string): Promise<AnalyticsPostDetailDto> {
    const post = await this.readModel.post(ref, variantId);
    if (!post) {
      throw new VariantNotFoundError();
    }
    return {
      ...toPostDto(post),
      snapshots: post.snapshots.map((snapshot) => ({
        capturedAt: snapshot.capturedAt.toISOString(),
        step: snapshot.step,
        metrics: { ...snapshot.metrics, engagements: engagementsOf(snapshot.metrics) },
      })),
    };
  }

  async account(
    ref: WorkspaceRef,
    accountId: string,
    selection: Pick<AnalyticsSelection, 'from' | 'to'>,
  ): Promise<AnalyticsAccountDto> {
    const account = await this.readModel.account(ref, accountId);
    if (!account) {
      throw new SocialAccountNotFoundError();
    }
    const { period } = await this.periodOf(ref, selection);
    const rows = await this.readModel.daily(ref, {
      from: period.from,
      to: period.to,
      accountIds: [accountId],
    });
    const byDay = new Map(rows.map((row) => [row.day, row]));
    return {
      account: { ...account, disconnectedAt: iso(account.disconnectedAt) },
      period: { from: period.from, to: period.to },
      days: daysBetween(period.from, period.to).map((day) => {
        const row = byDay.get(day);
        return {
          day,
          followers: row?.followers ?? null,
          accountReach: row?.accountReach ?? null,
          profileViews: row?.profileViews ?? null,
          impressions: row ? metricOf([row], 'impressions') : null,
          engagements: row?.engagements ?? null,
          postsPublished: row?.postsPublished ?? 0,
        };
      }),
    };
  }

  /** The rollup rows of the period for the export, a batch at a time. */
  exportRows(ref: WorkspaceRef, period: AnalyticsPeriod, selection: AnalyticsSelection) {
    return this.readModel.exportDaily(ref, { from: period.from, to: period.to, ...filterOf(selection) });
  }

  private postPeriod(
    period: AnalyticsPeriod,
    timeZone: string,
    selection: AnalyticsSelection,
  ): PostPeriodFilter {
    return {
      start: localDayRange(period.from, timeZone).from,
      end: localDayRange(period.to, timeZone).to,
      ...filterOf(selection),
    };
  }

  /** A cached overview; Redis away means no cache, not a failed request. */
  private async cached(key: string): Promise<AnalyticsOverviewDto | null> {
    try {
      const value = await this.redis.get(key);
      return value ? (JSON.parse(value) as AnalyticsOverviewDto) : null;
    } catch (error) {
      this.logger.warn({ err: error }, 'analytics.cache_unavailable');
      return null;
    }
  }

  private async cache(key: string, overview: AnalyticsOverviewDto): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(overview), 'EX', OVERVIEW_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error }, 'analytics.cache_unavailable');
    }
  }
}
