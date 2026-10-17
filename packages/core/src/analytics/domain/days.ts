import { resolveLocalTime } from '../../publishing/domain/local-time';

// Days in the time zone of a workspace (guide step 5.3): analytics counts per local day, not per
// UTC day. A day is written YYYY-MM-DD.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The day after, by the calendar. */
export const nextDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** The instant a local day starts in the zone; the first valid minute where midnight is skipped. */
export function startOfLocalDay(day: string, timeZone: string): Date {
  const resolution = resolveLocalTime(`${day}T00:00`, timeZone);
  switch (resolution.kind) {
    case 'exact':
    case 'ambiguous':
      return resolution.instant;
    case 'gap':
      return resolution.next.instant;
    case 'invalid':
      throw new RangeError(`${day} in ${timeZone} is not a day.`);
  }
}

/** The local day as a period of instants: from its start to the start of the next day. */
export const localDayRange = (day: string, timeZone: string): { from: Date; to: Date } => ({
  from: startOfLocalDay(day, timeZone),
  to: startOfLocalDay(nextDay(day), timeZone),
});

/** The local day of an instant in the zone. */
export function localDayOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The day a number of days before, by the calendar. */
export const daysBefore = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
