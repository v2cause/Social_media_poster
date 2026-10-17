'use client';

import { useAnalyticsAccount } from '@smp/api-client';
import type { AnalyticsAccountDto } from '@smp/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  NativeSelect,
} from '@smp/ui';
import { keepPreviousData } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useNow, useTranslations } from 'next-intl';
import { useState } from 'react';

import { PlatformMark } from '@/features/publishing/platform-mark';
import { localDateOf } from '@/features/publishing/zoned-time';
import { errorCodeOf } from '@/lib/errors';
import { useErrorMessage } from '@/lib/use-error-message';
import { useSearchState } from '@/lib/use-search-state';

import { AnalyticsFilterBar } from './analytics-filter-bar';
import { analyticsQuerySchema, periodOf } from './analytics-filters';
import { KpiTile } from './kpi-tile';
import { LineChart } from './line-chart';
import { platformStyle } from './series-style';
import { useAnalyticsFormat } from './use-analytics-format';

// The analytics of one account (guide step 5.5): its followers per day and its daily numbers in
// the chosen period, as charts and tables. The daily numbers of the account come from its own
// poll; impressions and engagements from the posts published on it.

const DAILY_METRICS = [
  'impressions',
  'engagements',
  'accountReach',
  'profileViews',
  'postsPublished',
] as const;
type DailyMetric = (typeof DAILY_METRICS)[number];
const isDailyMetric = (value: string): value is DailyMetric =>
  (DAILY_METRICS as readonly string[]).includes(value);

/** The sum of the values of a period; null when no day has one. */
const sumOf = (values: readonly (number | null)[]): number | null =>
  values.some((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;

export function AccountAnalyticsPage(props: { ws: string; accountId: string; timeZone: string }) {
  const t = useTranslations('analytics');
  const states = useTranslations('states');
  const errorMessage = useErrorMessage();
  const now = useNow({ updateInterval: 60_000 });
  const today = localDateOf(now, props.timeZone);
  const [query, setQuery] = useSearchState(analyticsQuerySchema);
  const resolved = periodOf(query, today);
  const account = useAnalyticsAccount(
    props.ws,
    props.accountId,
    resolved.problem === null ? resolved.period : undefined,
    { query: { enabled: resolved.problem === null, placeholderData: keepPreviousData } },
  );

  let content;
  if (resolved.problem !== null) {
    content = <Alert title={t(`filters.problems.${resolved.problem}`)} />;
  } else if (account.isPending) {
    content = <LoadingState label={states('loading')} rows={4} />;
  } else if (account.isError) {
    content =
      errorCodeOf(account.error) === 'SOCIAL_ACCOUNT_NOT_FOUND' ? (
        <EmptyState title={t('account.notFound')} />
      ) : (
        <ErrorState title={states('error')} description={errorMessage(account.error)} />
      );
  } else {
    content = <AccountAnalytics data={account.data} />;
  }
  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href={`/w/${props.ws}/analytics`}>
          <ArrowLeft aria-hidden="true" />
          {t('account.back')}
        </Link>
      </Button>
      <h1 className="text-2xl font-semibold">{t('account.title')}</h1>
      <AnalyticsFilterBar
        query={query}
        onChange={setQuery}
        accounts={[]}
        period={resolved.period}
        problem={resolved.problem}
        periodOnly
      />
      {content}
    </div>
  );
}

function AccountAnalytics(props: { data: AnalyticsAccountDto }) {
  const { account, days } = props.data;
  const t = useTranslations('analytics');
  const types = useTranslations('accounts.list.type');
  const format = useAnalyticsFormat();
  const [metric, setMetric] = useState<DailyMetric>('impressions');
  const followers = days.map((day) => day.followers);
  const known = followers.filter((value): value is number => value !== null);
  const first = known[0] ?? null;
  const last = known.at(-1) ?? null;
  const labels = days.map((day) => format.day(day.day));
  const style = platformStyle(account.platform);

  return (
    <>
      <Card>
        <CardContent className="flex items-center gap-3 pt-6">
          <PlatformMark platform={account.platform} size="md" />
          <div className="flex min-w-0 flex-col">
            <p className="truncate font-medium">{account.name}</p>
            <p className="text-sm text-muted-foreground">
              {[account.handle ? `@${account.handle}` : null, types(account.type)]
                .filter((part): part is string => part !== null)
                .join(' · ')}
            </p>
          </div>
          {account.disconnectedAt ? (
            <Badge variant="muted" className="ml-auto">
              {t('account.disconnected')}
            </Badge>
          ) : null}
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <KpiTile label={t('account.followers')} value={last} series={followers} />
        <KpiTile
          label={t('kpis.followerGrowth')}
          value={first !== null && last !== null ? last - first : null}
        />
        <KpiTile
          label={t('metrics.impressions')}
          value={sumOf(days.map((day) => day.impressions))}
          series={days.map((day) => day.impressions)}
        />
        <KpiTile
          label={t('metrics.engagements')}
          value={sumOf(days.map((day) => day.engagements))}
          series={days.map((day) => day.engagements)}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('account.followersChart')}</CardTitle>
        </CardHeader>
        <CardContent>
          <LineChart
            title={t('account.followersChart')}
            labels={labels}
            series={[{ key: 'followers', label: t('account.followers'), style, values: followers }]}
            formatValue={(value) => format.value(value)}
            formatTick={(value) => format.tick(value)}
            fromZero={false}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row flex-wrap items-end justify-between gap-3 space-y-0">
          <CardTitle className="text-lg">{t('account.dailyChart')}</CardTitle>
          <FormField id="account-metric" label={t('account.metric')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={metric}
                onChange={(event) => {
                  if (isDailyMetric(event.target.value)) {
                    setMetric(event.target.value);
                  }
                }}
              >
                {DAILY_METRICS.map((key) => (
                  <option key={key} value={key}>
                    {t(`metrics.${key}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
        </CardHeader>
        <CardContent>
          <LineChart
            title={`${t('account.dailyChart')}: ${t(`metrics.${metric}`)}`}
            labels={labels}
            series={[
              { key: metric, label: t(`metrics.${metric}`), style, values: days.map((day) => day[metric]) },
            ]}
            formatValue={(value) => format.value(value)}
            formatTick={(value) => format.tick(value)}
          />
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">{t('notAvailableHint')}</p>
    </>
  );
}
