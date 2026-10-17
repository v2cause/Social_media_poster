import type { VariantListItemDto } from '@smp/contracts';

import type { VariantStatusDto } from '@/features/publishing/statuses';
import {
  addDays,
  instantOf,
  localDateOf,
  localDateTimeOf,
  startOfLocalDay,
  weekdayOf,
} from '@/features/publishing/zoned-time';

// The calendar of guide step 4.11 without a browser: the days of a view, the planned period it
// asks the API for, the variants of each day in the time zone shown, and where a variant lands
// when it moves to another day. Weeks start on Monday.

export const CALENDAR_VIEWS = ['month', 'week', 'list'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/** A planned variant can move; once it is on its way or done, it stays. */
const MOVABLE: readonly VariantStatusDto[] = ['SCHEDULED', 'QUEUED'];
export const isMovable = (item: Pick<VariantListItemDto, 'status'>): boolean => MOVABLE.includes(item.status);

const firstOfMonth = (date: string): string => `${date.slice(0, 7)}-01`;

/** The first day of the month a number of months after the month of the date. */
export function shiftMonth(date: string, months: number): string {
  const [year = 0, month = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 10);
}

const span = (first: string, last: string): string[] => {
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
};

/** The days a view shows around its anchor day: the weeks of the month, one week, or the month. */
export function daysOf(view: CalendarView, anchor: string): string[] {
  if (view === 'week') {
    return span(addDays(anchor, -weekdayOf(anchor)), addDays(anchor, 6 - weekdayOf(anchor)));
  }
  const first = firstOfMonth(anchor);
  const last = addDays(shiftMonth(first, 1), -1);
  return view === 'list'
    ? span(first, last)
    : span(addDays(first, -weekdayOf(first)), addDays(last, 6 - weekdayOf(last)));
}

/** The anchor of the period before or after: a week, or a month. */
export const shiftAnchor = (view: CalendarView, anchor: string, step: number): string =>
  view === 'week' ? addDays(anchor, 7 * step) : shiftMonth(anchor, step);

/** The planned period of the days, as the API takes it: from the first day to the day after the last. */
export function periodOf(days: readonly string[], timeZone: string): { from: string; to: string } {
  const first = days[0] ?? '';
  const last = days.at(-1) ?? first;
  return {
    from: startOfLocalDay(first, timeZone).toISOString(),
    to: startOfLocalDay(addDays(last, 1), timeZone).toISOString(),
  };
}

/** The variants of each day in the zone, in the order of their time. */
export function byDay(
  items: readonly VariantListItemDto[],
  timeZone: string,
): Map<string, VariantListItemDto[]> {
  const days = new Map<string, VariantListItemDto[]>();
  for (const item of items) {
    if (item.scheduledAt === null) {
      continue;
    }
    const day = localDateOf(new Date(item.scheduledAt), timeZone);
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  for (const list of days.values()) {
    list.sort((a, b) => Date.parse(a.scheduledAt ?? '') - Date.parse(b.scheduledAt ?? ''));
  }
  return days;
}

export interface Move {
  /** The new time as the calendar shows it. */
  instant: Date;
  /** The same time on the clock of the zone the variant is planned in, as the API takes it. */
  localDateTime: string;
  timeZone: string;
}

/**
 * A new local date and time in the zone the calendar shows, sent in the zone of the plan, so a
 * move never changes the zone of a variant.
 */
export function moveTo(
  item: Pick<VariantListItemDto, 'scheduledTimezone'>,
  localDateTime: string,
  viewZone: string,
): Move {
  const instant = instantOf(localDateTime, viewZone);
  const timeZone = item.scheduledTimezone ?? viewZone;
  return { instant, localDateTime: localDateTimeOf(instant, timeZone), timeZone };
}

/** A move to another day at the same time of day, as the calendar shows it. */
export function moveToDay(
  item: Pick<VariantListItemDto, 'scheduledAt' | 'scheduledTimezone'>,
  day: string,
  viewZone: string,
): Move {
  const time = localDateTimeOf(new Date(item.scheduledAt ?? 0), viewZone).slice(11);
  return moveTo(item, `${day}T${time}`, viewZone);
}

const PREVIEW_LENGTH = 40;

/** The first 40 characters of the text. */
export const shortPreview = (preview: string): string =>
  preview.length > PREVIEW_LENGTH ? `${preview.slice(0, PREVIEW_LENGTH).trimEnd()}...` : preview;
