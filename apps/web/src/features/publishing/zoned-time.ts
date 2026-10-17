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

/** The wall clock of an instant in the zone, as the milliseconds of the same wall clock in UTC. */
function wallClockOf(instant: number, timeZone: string): number {
  const [date = '', time = ''] = localDateTimeOf(new Date(instant), timeZone).split('T');
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
}

/**
 * The instant of a local date and time (YYYY-MM-DDTHH:mm) in the zone, resolved like the API: in
 * a repeated hour the earlier instant, in the gap of a change of the clocks the first minute
 * after it.
 */
export function instantOf(localDateTime: string, timeZone: string): Date {
  const [date = '', time = '00:00'] = localDateTime.split('T');
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number): number => wallClockOf(instant, timeZone) - instant;
  // The offsets a day before and a day after enclose any change near this wall time.
  const offsetBefore = offsetAt(wall - DAY_MS);
  const candidates = [...new Set([wall - offsetBefore, wall - offsetAt(wall + DAY_MS)])]
    .filter((instant) => wall - offsetAt(instant) === instant)
    .sort((a, b) => a - b);
  const [first] = candidates;
  if (first !== undefined) {
    return new Date(first);
  }
  // In a gap: the first minute after it is where the new offset starts.
  let low = (wall - DAY_MS) / MINUTE_MS;
  let high = (wall + DAY_MS) / MINUTE_MS;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(middle * MINUTE_MS) === offsetBefore) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return new Date(high * MINUTE_MS);
}

/** The first instant of a local day (YYYY-MM-DD) in the zone. */
export const startOfLocalDay = (date: string, timeZone: string): Date => instantOf(`${date}T00:00`, timeZone);

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
