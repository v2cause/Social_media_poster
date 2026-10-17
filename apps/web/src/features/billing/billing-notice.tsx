'use client';

import { cn } from '@smp/ui';
import { AlertCircle, Info } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import type { BillingNotice } from './billing-model';

/**
 * The notice above every page of an organization whose subscription needs something (guide step
 * 7.4): read-only, an overdue payment, or a trial about to end. Owners get the way to billing,
 * everyone else whom to ask.
 */
export function BillingNoticeBar(props: {
  notice: BillingNotice;
  organizationId: string;
  canManage: boolean;
}) {
  const t = useTranslations('billing.notice');
  const format = useFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const { notice } = props;
  const urgent = notice.kind !== 'trial_ending';
  const text =
    notice.kind === 'read_only'
      ? t('readOnly')
      : notice.kind === 'past_due'
        ? t('pastDue', { date: date(notice.graceEndsAt) })
        : t('trialEnding', { date: date(notice.trialEndsAt) });
  const Icon = urgent ? AlertCircle : Info;

  return (
    <div
      role={urgent ? 'alert' : 'status'}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm',
        urgent ? 'border-destructive/40 bg-destructive/10' : 'border-border bg-muted',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span>{text}</span>
      {props.canManage ? (
        <Link
          href={`/org/${props.organizationId}/billing`}
          className="font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('action')}
        </Link>
      ) : (
        <span className="text-muted-foreground">{t('askOwner')}</span>
      )}
    </div>
  );
}
