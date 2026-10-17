'use client';

import { usePublishingList } from '@smp/api-client';
import type { VariantListItemDto } from '@smp/contracts';
import { Button, EmptyState, ErrorState, LoadingState } from '@smp/ui';
import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';

import { PlatformMark } from '@/features/publishing/platform-mark';
import { VariantStatusBadge } from '@/features/publishing/variant-status';

import { countdownOf } from './countdown';

// The widget "next posts" of the dashboard (guide step 4.11): the next five planned or queued
// variants with a countdown in the time zone of the workspace. Live events of a status refresh
// it like every list of variants.

const LIMIT = 5;

export function NextPosts(props: { ws: string; timeZone: string }) {
  const t = useTranslations('dashboard');
  const states = useTranslations('states');
  const query = usePublishingList(props.ws, { order: 'schedule', status: 'SCHEDULED,QUEUED', limit: LIMIT });

  if (query.isPending) {
    return <LoadingState label={states('loading')} rows={3} />;
  }
  if (query.isError) {
    return <ErrorState title={states('error')} />;
  }
  if (query.data.items.length === 0) {
    return (
      <EmptyState
        title={t('noPosts')}
        description={t('noPostsHint')}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={`/w/${props.ws}/compose`}>{t('toCompose')}</Link>
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col divide-y divide-border">
        {query.data.items.map((item) => (
          <NextPost key={item.id} ws={props.ws} item={item} timeZone={props.timeZone} />
        ))}
      </ol>
      <Button asChild variant="outline" size="sm" className="self-start">
        <Link href={`/w/${props.ws}/calendar`}>{t('toCalendar')}</Link>
      </Button>
    </div>
  );
}

function NextPost(props: { ws: string; item: VariantListItemDto; timeZone: string }) {
  const { item } = props;
  const t = useTranslations('dashboard');
  const posts = useTranslations('posts');
  const format = useFormatter();
  const now = useNow({ updateInterval: 1_000 });
  const at = new Date(item.scheduledAt ?? 0);
  const countdown = countdownOf(at, now);
  return (
    <li className="flex items-start gap-3 py-2">
      <PlatformMark platform={item.platform} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link
          href={`/w/${props.ws}/posts/${item.postId}`}
          className="truncate text-sm font-medium hover:underline"
        >
          {item.preview === '' ? posts('noText') : item.preview}
        </Link>
        <span className="text-xs text-muted-foreground">
          {format.dateTime(at, { dateStyle: 'medium', timeStyle: 'short', timeZone: props.timeZone })}
          {item.account ? ` · ${item.account.name}` : null}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-sm font-medium tabular-nums">
          {countdown.kind === 'due'
            ? t('countdown.due')
            : countdown.kind === 'clock'
              ? t('countdown.clock', {
                  minutes: String(countdown.minutes),
                  seconds: String(countdown.seconds).padStart(2, '0'),
                })
              : format.relativeTime(at, now)}
        </span>
        <VariantStatusBadge status={item.status} />
      </div>
    </li>
  );
}
