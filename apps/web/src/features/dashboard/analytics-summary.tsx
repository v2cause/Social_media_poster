'use client';

import { useAnalyticsOverview, useAnalyticsTopPosts } from '@smp/api-client';
import { Button, EmptyState, ErrorState, LoadingState } from '@smp/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { KpiRow } from '@/features/analytics/analytics-page';
import { isEmptyOverview } from '@/features/analytics/analytics-model';
import { TopPostsTable } from '@/features/analytics/top-posts-table';
import { useErrorMessage } from '@/lib/use-error-message';

// The analytics of the dashboard (guide step 5.5): four KPIs of the last 30 days against the 30
// before, and the three posts with the most engagements, with the way to the full analytics.

const TOP_POSTS = 3;

export function AnalyticsSummary(props: { ws: string; timeZone: string }) {
  const t = useTranslations('analytics');
  const states = useTranslations('states');
  const errorMessage = useErrorMessage();
  const overview = useAnalyticsOverview(props.ws, undefined);
  const top = useAnalyticsTopPosts(props.ws, { limit: TOP_POSTS });

  if (overview.isPending) {
    return <LoadingState label={states('loading')} rows={2} />;
  }
  if (overview.isError) {
    return <ErrorState title={states('error')} description={errorMessage(overview.error)} />;
  }
  if (isEmptyOverview(overview.data)) {
    return <EmptyState title={t('empty.title')} description={t('empty.description')} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <KpiRow overview={overview.data} compact />
      {top.data && top.data.items.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('dashboard.topPosts')}</h3>
          <TopPostsTable ws={props.ws} timeZone={props.timeZone} items={top.data.items} compact />
        </div>
      ) : null}
      <Button asChild variant="outline" size="sm" className="self-start">
        <Link href={`/w/${props.ws}/analytics`}>{t('dashboard.toAnalytics')}</Link>
      </Button>
    </div>
  );
}
