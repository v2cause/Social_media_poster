// Dates and times in a time zone for the calendar and the filters of the post list (guide step
// 4.11). The browser shows the plan in the time zone of the workspace or of the user, not in
// its own; Intl knows every IANA zone, so nothing else is needed. The API takes local date and
// time with their zone and resolves changes of the clocks itself.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The local date and time of an instant in the zone, as YYYY-MM-DDTHH:mm. */
export function localDateTimeOf(instant: Date, timeZone: string): string {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterOf(timeZone).formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}T${parts.hour ?? ''}:${parts.minute ?? ''}`;
}

/** The local date of an instant in the zone, as YYYY-MM-DD. */
export const localDateOf = (instant: Date, timeZone: string): string =>
  localDateTimeOf(instant, timeZone).slice(0, 10);

/**
 * The first instant of a local day (YYYY-MM-DD) in the zone. Where the clocks skip midnight, the
 * day starts with the first minute after the gap.
 */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day);
  // Offsets stay within 14 hours, so the day starts within a day of its midnight in UTC.
  let low = (wall - DAY_MS) / MINUTE_MS;
  let high = (wall + DAY_MS) / MINUTE_MS;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDateOf(new Date(middle * MINUTE_MS), timeZone) < date) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return new Date(high * MINUTE_MS);
}

/** The local date a number of days after another, as YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The weekday of a local date, Monday 0 to Sunday 6. */
export function weekdayOf(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}
