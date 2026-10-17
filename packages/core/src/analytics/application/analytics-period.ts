import type { Clock } from '../../shared/ports/clock';
import { localDayOf } from '../domain/days';
import { AnalyticsHistoryExceededError } from '../domain/errors';
import { analyticsPeriodOf, type AnalyticsPeriod } from '../domain/period';

// The period of an analytics request in the time zone of its workspace, checked against the
// analytics history of the plan (guide step 5.4). Until billing (phase 7) every organization
// keeps the same history, from ANALYTICS_HISTORY_DAYS.

/** How many days of analytics the plan of an organization keeps. */
export interface AnalyticsHistory {
  daysOf(organizationId: string): Promise<number>;
}

/** The same history for every organization, until billing (phase 7). */
export const fixedAnalyticsHistory = (days: number): AnalyticsHistory => ({
  daysOf: () => Promise.resolve(days),
});

export async function resolveAnalyticsPeriod(
  deps: { history: AnalyticsHistory; clock: Clock },
  scope: { organizationId: string; timeZone: string },
  asked: { from?: string | undefined; to?: string | undefined },
): Promise<AnalyticsPeriod> {
  const today = localDayOf(deps.clock.now(), scope.timeZone);
  const period = analyticsPeriodOf(asked, today, await deps.history.daysOf(scope.organizationId));
  if (period.from < period.historyFrom) {
    throw new AnalyticsHistoryExceededError(period.historyFrom);
  }
  return period;
}
