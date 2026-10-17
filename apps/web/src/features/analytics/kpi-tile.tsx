'use client';

import { cn } from '@smp/ui';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { changeOf } from './analytics-model';
import { Sparkline } from './sparkline';
import { useAnalyticsFormat, type ValueKind } from './use-analytics-format';

// A KPI tile of the analytics views (guide step 5.5): the value of the period, its change against
// the period before with an arrow, a sign and a color, and a sparkline of its days. "n. v." stands
// where no platform reports the value; without a value before there is no comparison, and a tile
// without a period before shows none.

const ICONS = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight } as const;
const TONES = { up: 'text-success', down: 'text-destructive', flat: 'text-muted-foreground' } as const;

export function KpiTile(props: {
  label: string;
  value: number | null;
  /** The value of the period before; left out where there is no such period. */
  previous?: number | null;
  kind?: ValueKind;
  /** One value per day of the period. */
  series?: readonly (number | null)[];
  /** A line under the value, for example where the reach comes from. */
  note?: string | null;
}) {
  const t = useTranslations('analytics.kpis');
  const format = useAnalyticsFormat();
  const kind = props.kind ?? 'count';
  const change = changeOf(props.value, props.previous ?? null, kind);
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-4"
    >
      <p id={id} className="text-sm text-muted-foreground">
        {props.label}
      </p>
      <div className="flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold tabular-nums">{format.value(props.value, kind)}</p>
        {props.series ? <Sparkline values={props.series} /> : null}
      </div>
      {props.note ? <p className="text-xs text-muted-foreground">{props.note}</p> : null}
      {props.previous === undefined ? null : change.kind === 'none' ? (
        <p className="text-xs text-muted-foreground">{t('noChange')}</p>
      ) : (
        <ChangeLine direction={change.direction} text={t('change', { change: format.change(change) })} />
      )}
    </div>
  );
}

function ChangeLine(props: { direction: keyof typeof ICONS; text: string }) {
  const t = useTranslations('analytics.kpis.direction');
  const Icon = ICONS[props.direction];
  return (
    <p className={cn('flex items-center gap-1 text-xs', TONES[props.direction])}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t(props.direction)}:</span>
      <span className="tabular-nums">{props.text}</span>
    </p>
  );
}
