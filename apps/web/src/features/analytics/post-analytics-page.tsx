'use client';

import { useAnalyticsPost } from '@smp/api-client';
import type { AnalyticsPostDetailDto } from '@smp/contracts';
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
import { ArrowLeft, ExternalLink, PenSquare } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { useStyleName } from '@/features/composer/style-select';
import { PlatformMark } from '@/features/publishing/platform-mark';
import { errorCodeOf } from '@/lib/errors';
import { useErrorMessage } from '@/lib/use-error-message';

import { LineChart } from './line-chart';
import { platformStyle } from './series-style';
import { useAnalyticsFormat } from './use-analytics-format';

// The analytics of one published variant (guide step 5.5): what it is and where it went, its
// latest numbers with "n. v." for what the platform does not report, and the history of its
// polls as a chart and a table, labeled by the time since the publication.

const POST_METRICS = [
  'impressions',
  'reach',
  'views',
  'likes',
  'comments',
  'shares',
  'clicks',
  'saves',
  'engagements',
] as const;
type PostMetric = (typeof POST_METRICS)[number];
const isPostMetric = (value: string): value is PostMetric =>
  (POST_METRICS as readonly string[]).includes(value);

const HOUR_MS = 3_600_000;

export function PostAnalyticsPage(props: { ws: string; variantId: string; timeZone: string }) {
  const t = useTranslations('analytics.post');
  const states = useTranslations('states');
  const errorMessage = useErrorMessage();
  const query = useAnalyticsPost(props.ws, props.variantId);

  let content;
  if (query.isPending) {
    content = <LoadingState label={states('loading')} rows={4} />;
  } else if (query.isError) {
    content =
      errorCodeOf(query.error) === 'VARIANT_NOT_FOUND' ? (
        <EmptyState title={t('notFound')} />
      ) : (
        <ErrorState title={states('error')} description={errorMessage(query.error)} />
      );
  } else {
    content = <PostAnalytics ws={props.ws} timeZone={props.timeZone} post={query.data} />;
  }
  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href={`/w/${props.ws}/analytics`}>
          <ArrowLeft aria-hidden="true" />
          {t('back')}
        </Link>
      </Button>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {content}
    </div>
  );
}

function PostAnalytics(props: { ws: string; timeZone: string; post: AnalyticsPostDetailDto }) {
  const { post } = props;
  const t = useTranslations('analytics');
  const dates = useFormatter();
  const format = useAnalyticsFormat();
  const styleName = useStyleName();
  const [metric, setMetric] = useState<PostMetric>('impressions');
  const publishedAt = new Date(post.publishedAt);
  const when = (iso: string) =>
    dates.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone: props.timeZone });
  const after = (iso: string): string => {
    const hours = Math.max(0, Math.round((Date.parse(iso) - publishedAt.getTime()) / HOUR_MS));
    return hours < 48
      ? t('post.afterHours', { hours })
      : t('post.afterDays', { days: Math.round(hours / 24) });
  };

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <div className="flex items-start gap-3">
            <PlatformMark platform={post.platform} size="md" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="whitespace-pre-line">
                {post.preview === '' ? t('topPosts.noText') : post.preview}
              </p>
              <p className="text-sm text-muted-foreground">
                {[
                  post.account
                    ? `${post.account.name}${post.account.handle ? ` (@${post.account.handle})` : ''}`
                    : null,
                  t('post.publishedAt', { date: when(post.publishedAt) }),
                  post.style ? t('post.style', { style: styleName(post.style) }) : null,
                ]
                  .filter((part): part is string => part !== null)
                  .join(' · ')}
              </p>
              {post.externalDeletedAt ? (
                <Badge variant="muted" className="w-fit">
                  {t('topPosts.deleted')}
                </Badge>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/w/${props.ws}/posts/${post.postId}`}>
                <PenSquare aria-hidden="true" />
                {t('post.openPost')}
              </Link>
            </Button>
            {post.externalUrl && !post.externalDeletedAt ? (
              <Button asChild variant="outline" size="sm">
                <a href={post.externalUrl} target="_blank" rel="noreferrer noopener">
                  <ExternalLink aria-hidden="true" />
                  {t('post.openOnPlatform')}
                </a>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
      {post.externalDeletedAt ? (
        <Alert title={t('post.deleted', { date: when(post.externalDeletedAt) })} />
      ) : null}
      {post.metrics === null ? (
        <EmptyState title={t('post.noMetrics')} />
      ) : (
        <>
          <section aria-labelledby="post-latest" className="flex flex-col gap-2">
            <h2 id="post-latest" className="text-lg font-semibold">
              {t('post.latest')}
            </h2>
            {post.capturedAt ? (
              <p className="text-sm text-muted-foreground">
                {t('post.capturedAt', { date: when(post.capturedAt) })}
              </p>
            ) : null}
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {POST_METRICS.map((key) => (
                <div key={key} className="rounded-lg border border-border bg-card p-3">
                  <dt className="text-sm text-muted-foreground">{t(`metrics.${key}`)}</dt>
                  <dd className="text-xl font-semibold tabular-nums">
                    {format.value(post.metrics?.[key] ?? null)}
                  </dd>
                </div>
              ))}
              <div className="rounded-lg border border-border bg-card p-3">
                <dt className="text-sm text-muted-foreground">{t('metrics.engagementRate')}</dt>
                <dd className="text-xl font-semibold tabular-nums">
                  {format.value(post.engagementRate, 'rate')}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">{t('notAvailableHint')}</p>
          </section>
          <Card>
            <CardHeader className="flex-row flex-wrap items-end justify-between gap-3 space-y-0">
              <CardTitle className="text-lg">{t('post.history')}</CardTitle>
              <FormField id="post-metric" label={t('post.metric')}>
                {(control) => (
                  <NativeSelect
                    {...control}
                    value={metric}
                    onChange={(event) => {
                      if (isPostMetric(event.target.value)) {
                        setMetric(event.target.value);
                      }
                    }}
                  >
                    {POST_METRICS.map((key) => (
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
                title={`${t('post.history')}: ${t(`metrics.${metric}`)}`}
                labels={post.snapshots.map((snapshot) => after(snapshot.capturedAt))}
                series={[
                  {
                    key: metric,
                    label: t(`metrics.${metric}`),
                    style: platformStyle(post.platform),
                    values: post.snapshots.map((snapshot) => snapshot.metrics[metric]),
                  },
                ]}
                formatValue={(value) => format.value(value)}
                formatTick={(value) => format.tick(value)}
              />
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
