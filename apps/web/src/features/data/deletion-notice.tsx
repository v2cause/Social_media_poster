'use client';

import { EmptyState, cn } from '@smp/ui';
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

// What the members of a deleted organization see while it waits for its erasure (guide step 8.2):
// a notice above every page and, in place of the pages that no longer work, an explanation.
// Owners get the way to the data page, where they take the deletion back or export the data.

const linkClasses =
  'font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function DeletionNoticeBar(props: {
  eraseAfter: string;
  organizationId: string;
  canRestore: boolean;
}) {
  const t = useTranslations('data.deletion');
  const format = useFormatter();
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm',
        'border-destructive/40 bg-destructive/10',
      )}
    >
      <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
      <span>{t('notice', { date: format.dateTime(new Date(props.eraseAfter), { dateStyle: 'long' }) })}</span>
      {props.canRestore ? (
        <Link href={`/org/${props.organizationId}/data`} className={linkClasses}>
          {t('noticeAction')}
        </Link>
      ) : (
        <span className="text-muted-foreground">{t('askOwner')}</span>
      )}
    </div>
  );
}

export function OrganizationDeletedNotice(props: {
  eraseAfter: string;
  organizationId: string;
  canRestore: boolean;
}) {
  const t = useTranslations('data.deletion');
  const format = useFormatter();
  return (
    <EmptyState
      title={t('blockedTitle')}
      description={t('blockedDescription', {
        date: format.dateTime(new Date(props.eraseAfter), { dateStyle: 'long' }),
      })}
      action={
        props.canRestore ? (
          <Link href={`/org/${props.organizationId}/data`} className={linkClasses}>
            {t('noticeAction')}
          </Link>
        ) : (
          <span className="text-sm text-muted-foreground">{t('askOwner')}</span>
        )
      }
    />
  );
}
