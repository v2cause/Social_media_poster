'use client';

import type { AnalyticsPostDto } from '@smp/contracts';
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@smp/ui';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { useStyleName } from '@/features/composer/style-select';
import { PlatformMark } from '@/features/publishing/platform-mark';

import { useAnalyticsFormat } from './use-analytics-format';

// The top posts of a period (guide step 5.5): one row per published variant with its account,
// style, publication and numbers; the preview leads to the analytics of the variant. A post the
// platform deleted keeps its numbers and says so.

export function TopPostsTable(props: {
  ws: string;
  timeZone: string;
  items: readonly AnalyticsPostDto[];
  /** Fewer columns, for the dashboard. */
  compact?: boolean;
}) {
  const t = useTranslations('analytics');
  const format = useAnalyticsFormat();
  const dates = useFormatter();
  const styleName = useStyleName();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('topPosts.post')}</TableHead>
          {props.compact ? null : <TableHead>{t('topPosts.publishedAt')}</TableHead>}
          {props.compact ? null : <TableHead className="text-right">{t('metrics.impressions')}</TableHead>}
          <TableHead className="text-right">{t('metrics.engagements')}</TableHead>
          <TableHead className="text-right">{t('metrics.engagementRate')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.items.map((item) => (
          <TableRow key={item.variantId}>
            <TableCell className="max-w-md">
              <div className="flex items-start gap-2">
                <PlatformMark platform={item.platform} className="mt-0.5" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Link
                    href={`/w/${props.ws}/analytics/posts/${item.variantId}`}
                    className="truncate font-medium hover:underline"
                  >
                    {item.preview === '' ? t('topPosts.noText') : item.preview}
                  </Link>
                  <span className="truncate text-xs text-muted-foreground">
                    {item.account ? (
                      <Link
                        href={`/w/${props.ws}/analytics/accounts/${item.account.id}`}
                        // A line of 24 px makes the target large enough (WCAG 2.5.8, guide step 8.8).
                        className="inline-block min-w-6 max-w-full truncate align-bottom leading-6 hover:text-foreground hover:underline"
                      >
                        {item.account.name}
                      </Link>
                    ) : null}
                    {item.account && item.style ? ' · ' : null}
                    {item.style ? styleName(item.style) : null}
                  </span>
                  {item.externalDeletedAt ? (
                    <Badge variant="muted" className="w-fit">
                      {t('topPosts.deleted')}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </TableCell>
            {props.compact ? null : (
              <TableCell className="whitespace-nowrap">
                {dates.dateTime(new Date(item.publishedAt), {
                  dateStyle: 'medium',
                  timeZone: props.timeZone,
                })}
              </TableCell>
            )}
            {props.compact ? null : (
              <TableCell className="text-right tabular-nums">
                {format.value(item.metrics?.impressions ?? null)}
              </TableCell>
            )}
            <TableCell className="text-right tabular-nums">
              {format.value(item.metrics?.engagements ?? null)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {format.value(item.engagementRate, 'rate')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
