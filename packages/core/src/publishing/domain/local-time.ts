// A local date and time in an IANA time zone, turned into an instant (architecture 7.3). Pure:
// it uses nothing but Intl, which every runtime brings. Around a change of the offset:
// - spring forward: the local times in the gap do not exist; the result names the first valid
//   minute after the gap as a suggestion;
// - fall back: the local times of the repeated hour exist twice; the earlier instant (the offset
//   in force before the change) wins, the later one is reported as well.

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type LocalTimeResolution =
  | { kind: 'exact'; instant: Date }
  | { kind: 'ambiguous'; instant: Date; later: Date }
  | { kind: 'gap'; next: { localDateTime: string; instant: Date } }
  /** Not a date and time of the form YYYY-MM-DDTHH:mm, or an unknown time zone. */
  | { kind: 'invalid' };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) {
    return cached;
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/** The wall clock of an instant in the zone, as the milliseconds of the same wall clock in UTC. */
function wallClockOf(formatter: Intl.DateTimeFormat, instant: number): number {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

const offsetAt = (formatter: Intl.DateTimeFormat, instant: number): number =>
  wallClockOf(formatter, instant) - instant;

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

const localOf = (wallClock: number): string => {
  const date = new Date(wallClock);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}`;
};

/** True for an IANA time zone the runtime knows. */
export const isKnownTimeZone = (timeZone: string): boolean => formatterOf(timeZone) !== null;

/** The local date and time of an instant in a zone, as YYYY-MM-DDTHH:mm. */
export function formatLocalTime(instant: Date, timeZone: string): string {
  const formatter = formatterOf(timeZone);
  if (!formatter) {
    throw new RangeError(`Unknown time zone ${timeZone}`);
  }
  return localOf(wallClockOf(formatter, instant.getTime()));
}

export function resolveLocalTime(localDateTime: string, timeZone: string): LocalTimeResolution {
  const match = LOCAL_DATE_TIME.exec(localDateTime);
  const formatter = formatterOf(timeZone);
  if (!match || !formatter) {
    return { kind: 'invalid' };
  }
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Date.UTC rolls over, for example from February 30 to March 2.
  if (hour > 23 || minute > 59 || localOf(wall) !== localDateTime) {
    return { kind: 'invalid' };
  }

  // The offsets a day before and a day after enclose any change near this wall time.
  const offsetBefore = offsetAt(formatter, wall - DAY_MS);
  const offsetAfter = offsetAt(formatter, wall + DAY_MS);
  const candidates = [...new Set([wall - offsetBefore, wall - offsetAfter])]
    .filter((instant) => wall - offsetAt(formatter, instant) === instant)
    .sort((a, b) => a - b);
  const [first, second] = candidates;
  if (first !== undefined && second !== undefined) {
    return { kind: 'ambiguous', instant: new Date(first), later: new Date(second) };
  }
  if (first !== undefined) {
    return { kind: 'exact', instant: new Date(first) };
  }

  // In a gap: the first minute after it is the instant where the new offset starts.
  let low = (wall - DAY_MS) / MINUTE_MS;
  let high = (wall + DAY_MS) / MINUTE_MS;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(formatter, middle * MINUTE_MS) === offsetBefore) {
      low = middle;
    } else {
      high = middle;
    }
  }
  const instant = high * MINUTE_MS;
  return {
    kind: 'gap',
    next: { localDateTime: localOf(wallClockOf(formatter, instant)), instant: new Date(instant) },
  };
}
