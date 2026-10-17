'use client';

import { useFormatter, useTranslations } from 'next-intl';

import type { Change } from './analytics-model';

// The numbers of the analytics views (guide step 5.5): counts with grouping, rates as percent,
// short labels for axes, and "n. v." where a platform reports nothing, so a missing value never
// reads as 0. Days arrive as YYYY-MM-DD local to the workspace and are shown as such.

export type ValueKind = 'count' | 'rate';

/** A local day as a date at noon UTC, so no time zone moves it to another day. */
const dateOfDay = (day: string): Date => new Date(`${day}T12:00:00Z`);

export function useAnalyticsFormat() {
  const format = useFormatter();
  const t = useTranslations('analytics');
  const number = (value: number, kind: ValueKind): string =>
    kind === 'rate'
      ? format.number(value, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 2 })
      : format.number(value, { maximumFractionDigits: 0 });
  return {
    /** A value, or "n. v." for null. */
    value: (value: number | null, kind: ValueKind = 'count'): string =>
      value === null ? t('notAvailable') : number(value, kind),
    /** A short label of an axis. */
    tick: (value: number, kind: ValueKind = 'count'): string =>
      kind === 'rate'
        ? format.number(value, { style: 'percent', maximumFractionDigits: 1 })
        : format.number(value, { notation: 'compact', maximumFractionDigits: 1 }),
    /** The change against the period before, with its sign. */
    change: (change: Exclude<Change, { kind: 'none' }>): string =>
      change.kind === 'ratio'
        ? format.number(change.ratio, {
            style: 'percent',
            signDisplay: 'exceptZero',
            maximumFractionDigits: 1,
          })
        : t('kpis.points', {
            value: format.number(change.points, { signDisplay: 'exceptZero', maximumFractionDigits: 2 }),
          }),
    /** A local day, for example 17. Okt. */
    day: (day: string): string =>
      format.dateTime(dateOfDay(day), { day: 'numeric', month: 'short', timeZone: 'UTC' }),
    /** A local day with its year, for example 17.10.2026. */
    fullDay: (day: string): string =>
      format.dateTime(dateOfDay(day), { dateStyle: 'medium', timeZone: 'UTC' }),
    /** The month of a day, for example Okt. 2026. */
    month: (day: string): string =>
      format.dateTime(dateOfDay(day), { month: 'short', year: 'numeric', timeZone: 'UTC' }),
  };
}
