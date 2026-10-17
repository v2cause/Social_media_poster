import { daysBefore } from './days';

// The period of an analytics request (guide step 5.4): local days of the workspace, the last 30
// without a choice, limited by the history of the plan, compared with the period of the same
// length before it.

/** The days of a period without a choice: the last 30 up to today. */
export const DEFAULT_PERIOD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AnalyticsPeriod {
  from: string;
  to: string;
  /** The period of the same length before, cut at the history; null when it lies before it. */
  previous: { from: string; to: string } | null;
  /** The first day the plan keeps. */
  historyFrom: string;
}

export const periodLength = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/**
 * The period asked for, or the default one; `today` is the local day of the workspace. A start
 * after today without an end asks for that day alone. The caller checks the start against
 * historyFrom.
 */
export function analyticsPeriodOf(
  asked: { from?: string | undefined; to?: string | undefined },
  today: string,
  historyDays: number,
): AnalyticsPeriod {
  const to = asked.to ?? (asked.from !== undefined && asked.from > today ? asked.from : today);
  const from = asked.from ?? daysBefore(to, DEFAULT_PERIOD_DAYS - 1);
  const historyFrom = daysBefore(today, historyDays - 1);
  const previousTo = daysBefore(from, 1);
  const previousFrom = daysBefore(from, periodLength(from, to));
  return {
    from,
    to,
    previous:
      previousTo < historyFrom
        ? null
        : { from: previousFrom < historyFrom ? historyFrom : previousFrom, to: previousTo },
    historyFrom,
  };
}
