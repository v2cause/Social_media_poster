'use client';

import {
  getAnalyticsExportUrl,
  useAccountsList,
  useAnalyticsBreakdown,
  useAnalyticsOverview,
  useAnalyticsTimeseries,
  useAnalyticsTopPosts,
  type AnalyticsOverviewParams,
} from '@smp/api-client';
import {
  ANALYTICS_METRICS,
  ANALYTICS_GRANULARITIES,
  ANALYTICS_TOP_SORTS,
  type AnalyticsBreakdownDto,
  type AnalyticsOverviewDto,
} from '@smp/contracts';
import { PLATFORMS } from '@smp/platform-rules';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@smp/ui';
import { keepPreviousData } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useNow, useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';

import { useStyleName } from '@/features/composer/style-select';
import { PlatformMark } from '@/features/publishing/platform-mark';
import { localDateOf } from '@/features/publishing/zoned-time';
import { useErrorMessage } from '@/lib/use-error-message';
import { useSearchState } from '@/lib/use-search-state';

import { AnalyticsFilterBar } from './analytics-filter-bar';
import {
  COMPARE_METRICS,
  POST_BREAKDOWNS,
  analyticsQuerySchema,
  filterParamsOf,
  granularityOf,
  isPlatform,
  isRateMetric,
  isWeekdayKey,
  periodOf,
  type AnalyticsQuery,
  type CompareMetric,
  type Period,
} from './analytics-filters';
import { isEmptyOverview, maxOf } from './analytics-model';
import { BarList } from './bar-list';
import { KpiTile } from './kpi-tile';
import { LineChart } from './line-chart';
import { platformStyle } from './series-style';
import { TopPostsTable } from './top-posts-table';
import { useAnalyticsFormat } from './use-analytics-format';

// The analytics page of guide step 5.5: the filter bar, six KPIs against the period before with
// sparklines, a line chart per platform, the comparison of the platforms, the top posts and the
// breakdown by style or weekday, and the export of the period as CSV. All filters and views live
// in the query string. Rates come from the server; null stays "n. v.".

const keepData = { query: { placeholderData: keepPreviousData } };

export function AnalyticsPage(props: { ws: string; timeZone: string }) {
  const t = useTranslations('analytics');
  const now = useNow({ updateInterval: 60_000 });
  const today = localDateOf(now, props.timeZone);
  const [query, setQuery] = useSearchState(analyticsQuerySchema);
  const accounts = useAccountsList(props.ws);
  const resolved = periodOf(query, today);
  const params = resolved.problem === null ? filterParamsOf(query, resolved.period) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        {params ? (
          <Button asChild variant="outline">
            <a href={getAnalyticsExportUrl(props.ws, params)} download>
              <Download aria-hidden="true" />
              {t('export')}
            </a>
          </Button>
        ) : null}
      </div>
      <AnalyticsFilterBar
        query={query}
        onChange={setQuery}
        accounts={accounts.data?.items ?? []}
        period={resolved.period}
        problem={resolved.problem}
      />
      {resolved.problem === null ? (
        <AnalyticsSections
          ws={props.ws}
          timeZone={props.timeZone}
          query={query}
          onChange={setQuery}
          period={resolved.period}
          params={filterParamsOf(query, resolved.period)}
        />
      ) : (
        <Alert title={t(`filters.problems.${resolved.problem}`)} />
      )}
    </div>
  );
}

function AnalyticsSections(props: {
  ws: string;
  timeZone: string;
  query: AnalyticsQuery;
  onChange: (patch: Partial<AnalyticsQuery>) => void;
  period: Period;
  params: AnalyticsOverviewParams;
}) {
  const t = useTranslations('analytics');
  const states = useTranslations('states');
  const errorMessage = useErrorMessage();
  const format = useAnalyticsFormat();
  const overview = useAnalyticsOverview(props.ws, props.params, keepData);

  if (overview.isPending) {
    return <LoadingState label={states('loading')} rows={4} />;
  }
  if (overview.isError) {
    return <ErrorState title={states('error')} description={errorMessage(overview.error)} />;
  }
  if (isEmptyOverview(overview.data)) {
    return <EmptyState title={t('empty.title')} description={t('empty.description')} />;
  }
  const { previous } = overview.data;
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {t('period', {
          from: format.fullDay(overview.data.period.from),
          to: format.fullDay(overview.data.period.to),
        })}
        {' · '}
        {previous
          ? t('previous', { from: format.fullDay(previous.from), to: format.fullDay(previous.to) })
          : t('noPrevious')}
      </p>
      <KpiRow overview={overview.data} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <TimelineCard {...props} className="xl:col-span-2" />
        <ComparisonCard {...props} />
      </div>
      <TopPostsCard {...props} />
      <BreakdownCard {...props} />
    </>
  );
}

export function KpiRow(props: { overview: AnalyticsOverviewDto; compact?: boolean }) {
  const t = useTranslations('analytics');
  const id = useId();
  const { kpis, series } = props.overview;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="sr-only">
        {t('kpis.title')}
      </h2>
      <div
        className={cn(
          'grid grid-cols-1 gap-3 min-[420px]:grid-cols-2',
          props.compact ? 'lg:grid-cols-4' : 'md:grid-cols-3 2xl:grid-cols-6',
        )}
      >
        <KpiTile
          label={t('kpis.impressions')}
          value={kpis.impressions.value}
          previous={kpis.impressions.previous}
          series={series.impressions}
        />
        {props.compact ? null : (
          <KpiTile
            label={t('kpis.reach')}
            value={kpis.reach.value}
            previous={kpis.reach.previous}
            series={series.reach}
            note={kpis.reach.basis ? t(`kpis.reachBasis.${kpis.reach.basis}`) : null}
          />
        )}
        <KpiTile
          label={t('kpis.engagements')}
          value={kpis.engagements.value}
          previous={kpis.engagements.previous}
          series={series.engagements}
        />
        <KpiTile
          label={t('kpis.engagementRate')}
          value={kpis.engagementRate.value}
          previous={kpis.engagementRate.previous}
          series={series.engagementRate}
          kind="rate"
        />
        <KpiTile
          label={t('kpis.followerGrowth')}
          value={kpis.followerGrowth.value}
          previous={kpis.followerGrowth.previous}
          series={series.followers}
        />
        {props.compact ? null : (
          <KpiTile
            label={t('kpis.postsPublished')}
            value={kpis.postsPublished.value}
            previous={kpis.postsPublished.previous}
            series={series.postsPublished}
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('notAvailableHint')}</p>
    </section>
  );
}

/** The label of a bucket of the time axis: the day, the week from its Monday, or the month. */
function useBucketLabel(granularity: (typeof ANALYTICS_GRANULARITIES)[number]) {
  const t = useTranslations('analytics.chart');
  const format = useAnalyticsFormat();
  return (bucket: string): string =>
    granularity === 'day'
      ? format.day(bucket)
      : granularity === 'week'
        ? t('weekOf', { day: format.day(bucket) })
        : format.month(bucket);
}

function SectionCard(props: {
  title: string;
  description?: string;
  controls?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Card role="region" aria-labelledby={id} className={props.className}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="flex flex-col gap-1.5">
          <CardTitle id={id} className="text-lg">
            {props.title}
          </CardTitle>
          {props.description ? <CardDescription>{props.description}</CardDescription> : null}
        </div>
        {props.controls ? <div className="flex flex-wrap items-end gap-3">{props.controls}</div> : null}
      </CardHeader>
      <CardContent>{props.children}</CardContent>
    </Card>
  );
}

function SectionState(props: { query: { isPending: boolean; isError: boolean; error: unknown } }) {
  const states = useTranslations('states');
  const errorMessage = useErrorMessage();
  if (props.query.isPending) {
    return <LoadingState label={states('loading')} rows={3} />;
  }
  return props.query.isError ? (
    <ErrorState title={states('error')} description={errorMessage(props.query.error)} />
  ) : null;
}

function TimelineCard(props: {
  ws: string;
  query: AnalyticsQuery;
  onChange: (patch: Partial<AnalyticsQuery>) => void;
  period: Period;
  params: AnalyticsOverviewParams;
  className?: string;
}) {
  const t = useTranslations('analytics');
  const platformNames = useTranslations('platforms');
  const format = useAnalyticsFormat();
  const granularity = granularityOf(props.query, props.period);
  const bucketLabel = useBucketLabel(granularity);
  const metric = props.query.metric;
  const kind = isRateMetric(metric) ? 'rate' : 'count';
  const timeseries = useAnalyticsTimeseries(
    props.ws,
    { ...props.params, metric, granularity, groupBy: 'platform' },
    keepData,
  );
  // In the order of the filter bar, so a platform keeps its place in every view.
  const series = PLATFORMS.flatMap((platform) => {
    const item = timeseries.data?.series.find((candidate) => candidate.platform === platform);
    return item?.values.some((value) => value !== null)
      ? [
          {
            key: item.key,
            label: platformNames(platform),
            style: platformStyle(platform),
            values: item.values,
          },
        ]
      : [];
  });

  return (
    <SectionCard
      title={t('timeline.title')}
      className={props.className}
      controls={
        <>
          <FormField id="analytics-metric" label={t('timeline.metric')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={metric}
                onChange={(event) => {
                  props.onChange({ metric: analyticsQuerySchema.shape.metric.parse(event.target.value) });
                }}
              >
                {ANALYTICS_METRICS.map((option) => (
                  <option key={option} value={option}>
                    {t(`metrics.${option}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField id="analytics-granularity" label={t('timeline.granularity')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={granularity}
                onChange={(event) => {
                  props.onChange({
                    granularity: analyticsQuerySchema.shape.granularity.parse(event.target.value),
                  });
                }}
              >
                {ANALYTICS_GRANULARITIES.map((option) => (
                  <option key={option} value={option}>
                    {t(`granularities.${option}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
        </>
      }
    >
      {timeseries.data ? (
        series.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('timeline.empty')}</p>
        ) : (
          <LineChart
            title={`${t('timeline.title')}: ${t(`metrics.${metric}`)}`}
            labels={timeseries.data.buckets.map(bucketLabel)}
            series={series}
            formatValue={(value) => format.value(value, kind)}
            formatTick={(value) => format.tick(value, kind)}
            fromZero={metric !== 'followers'}
          />
        )
      ) : (
        <SectionState query={timeseries} />
      )}
    </SectionCard>
  );
}

const compareValueOf = (
  group: AnalyticsBreakdownDto['groups'][number],
  metric: CompareMetric,
): number | null => (metric === 'posts' ? group.posts : group[metric]);

function ComparisonCard(props: {
  ws: string;
  query: AnalyticsQuery;
  onChange: (patch: Partial<AnalyticsQuery>) => void;
  params: AnalyticsOverviewParams;
}) {
  const t = useTranslations('analytics');
  const platformNames = useTranslations('platforms');
  const format = useAnalyticsFormat();
  const metric = props.query.compare;
  const breakdown = useAnalyticsBreakdown(props.ws, { ...props.params, by: 'platform' }, keepData);
  return (
    <SectionCard
      title={t('comparison.title')}
      controls={
        <FormField id="analytics-compare" label={t('comparison.metric')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={metric}
              onChange={(event) => {
                props.onChange({ compare: analyticsQuerySchema.shape.compare.parse(event.target.value) });
              }}
            >
              {COMPARE_METRICS.map((option) => (
                <option key={option} value={option}>
                  {t(`metrics.${option}`)}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      }
    >
      {breakdown.data ? (
        breakdown.data.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('breakdown.empty')}</p>
        ) : (
          <BarList
            title={`${t('comparison.title')}: ${t(`metrics.${metric}`)}`}
            items={breakdown.data.groups
              .flatMap((group) => {
                const platform = group.key;
                return isPlatform(platform)
                  ? [
                      {
                        key: platform,
                        label: (
                          <>
                            <PlatformMark platform={platform} size="xs" />
                            <span className="truncate">{platformNames(platform)}</span>
                          </>
                        ),
                        value: compareValueOf(group, metric),
                        style: platformStyle(platform),
                      },
                    ]
                  : [];
              })
              // The largest first; a platform without a value last.
              .sort((a, b) => (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY))}
            formatValue={(value) => format.value(value, isRateMetric(metric) ? 'rate' : 'count')}
          />
        )
      ) : (
        <SectionState query={breakdown} />
      )}
    </SectionCard>
  );
}

function TopPostsCard(props: {
  ws: string;
  timeZone: string;
  query: AnalyticsQuery;
  onChange: (patch: Partial<AnalyticsQuery>) => void;
  params: AnalyticsOverviewParams;
}) {
  const t = useTranslations('analytics');
  const top = useAnalyticsTopPosts(
    props.ws,
    { ...props.params, sort: props.query.sort, limit: 10 },
    keepData,
  );
  return (
    <SectionCard
      title={t('topPosts.title')}
      controls={
        <FormField id="analytics-sort" label={t('topPosts.sort')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={props.query.sort}
              onChange={(event) => {
                props.onChange({ sort: analyticsQuerySchema.shape.sort.parse(event.target.value) });
              }}
            >
              {ANALYTICS_TOP_SORTS.map((option) => (
                <option key={option} value={option}>
                  {t(`metrics.${option}`)}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      }
    >
      {top.data ? (
        top.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('topPosts.empty')}</p>
        ) : (
          <TopPostsTable ws={props.ws} timeZone={props.timeZone} items={top.data.items} />
        )
      ) : (
        <SectionState query={top} />
      )}
    </SectionCard>
  );
}

function BreakdownCard(props: {
  ws: string;
  query: AnalyticsQuery;
  onChange: (patch: Partial<AnalyticsQuery>) => void;
  params: AnalyticsOverviewParams;
}) {
  const t = useTranslations('analytics');
  const format = useAnalyticsFormat();
  const styleName = useStyleName();
  const by = props.query.by;
  const breakdown = useAnalyticsBreakdown(props.ws, { ...props.params, by }, keepData);
  const groups = breakdown.data?.by === by ? breakdown.data.groups : [];
  const maxRate = maxOf(groups.map((group) => group.engagementRate));
  const labelOf = (group: AnalyticsBreakdownDto['groups'][number]): string => {
    if (by === 'weekday') {
      return isWeekdayKey(group.key) ? t(`breakdown.weekdays.${group.key}`) : group.key;
    }
    if (group.key === 'none' || group.label === null) {
      return t('breakdown.noStyle');
    }
    return group.preset ? styleName({ key: group.label, name: group.label }) : group.label;
  };

  return (
    <SectionCard
      title={by === 'style' ? t('breakdown.title') : t('breakdown.titleWeekday')}
      controls={
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium" id="analytics-breakdown-label">
            {t('breakdown.by')}
          </span>
          <div
            role="group"
            aria-labelledby="analytics-breakdown-label"
            className="flex rounded-md border border-border"
          >
            {POST_BREAKDOWNS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={by === option}
                className={cn(
                  'px-3 py-2 text-sm first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  by === option ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                )}
                onClick={() => {
                  props.onChange({ by: option });
                }}
              >
                {t(`breakdown.byOptions.${option}`)}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {breakdown.data ? (
        groups.every((group) => group.posts === 0) ? (
          <p className="text-sm text-muted-foreground">{t('breakdown.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(`breakdown.byOptions.${by}`)}</TableHead>
                <TableHead className="text-right">{t('breakdown.posts')}</TableHead>
                <TableHead className="text-right">{t('metrics.impressions')}</TableHead>
                <TableHead className="text-right">{t('metrics.engagements')}</TableHead>
                <TableHead className="w-1/3">{t('metrics.engagementRate')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <TableRow key={group.key}>
                  <TableCell className="font-medium">{labelOf(group)}</TableCell>
                  <TableCell className="text-right tabular-nums">{format.value(group.posts)}</TableCell>
                  <TableCell className="text-right tabular-nums">{format.value(group.impressions)}</TableCell>
                  <TableCell className="text-right tabular-nums">{format.value(group.engagements)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <span aria-hidden="true" className="h-2 flex-1 rounded-full bg-muted">
                        <span
                          className={cn(
                            'block h-2 rounded-full bg-chart-1',
                            group.engagementRate === null && 'hidden',
                          )}
                          style={{
                            width: `${String(
                              maxRate && group.engagementRate !== null
                                ? Math.round((group.engagementRate / maxRate) * 1000) / 10
                                : 0,
                            )}%`,
                          }}
                        />
                      </span>
                      <span className="w-16 text-right tabular-nums">
                        {format.value(group.engagementRate, 'rate')}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : (
        <SectionState query={breakdown} />
      )}
    </SectionCard>
  );
}
