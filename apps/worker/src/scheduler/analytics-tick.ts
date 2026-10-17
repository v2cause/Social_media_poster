import { daysBefore, NIGHTLY_ROLLUP_DAYS, type MetricsPlanScanner } from '@smp/core';
import type { AnalyticsProducer } from '@smp/queue';

import type { TickResult } from '../processors/scheduler.processor';

// The ticks of the analytics planner (guide step 5.2, architecture 8). tick.analytics (every 5
// minutes) adds a job metrics.post per account with due polls; its id holds the bucket of the
// tick, so one tick adds one job per account. tick.account-metrics (every hour) adds a job
// metrics.account per account whose numbers of the day before are missing once it is past 03:00
// in the time zone of its workspace; the jobs spread over the hour. tick.maintenance (nightly)
// rolls the last 35 days of every workspace with accounts up again (guide step 5.3).

/** Accounts per tick; the next tick takes the rest. */
const ACCOUNTS_PER_TICK = 1_000;
/** The daily polls of a tick spread over this much time. */
const ACCOUNT_SPREAD_MS = 50 * 60 * 1000;

/** The bucket of a tick: its time in UTC to the minute, for example 202610161505. */
export const bucketOf = (now: Date): string => now.toISOString().slice(0, 16).replace(/[-T:]/g, '');

/** A stable delay per account within the spread, so the accounts of a tick do not poll at once. */
export function spreadDelayMs(accountId: string, spreadMs = ACCOUNT_SPREAD_MS): number {
  let hash = 0;
  for (let index = 0; index < accountId.length; index += 1) {
    hash = (hash * 31 + accountId.charCodeAt(index)) % 1_000_003;
  }
  return hash % spreadMs;
}

interface AnalyticsTickDeps {
  scanner: MetricsPlanScanner;
  producer: Pick<AnalyticsProducer, 'postMetrics' | 'accountMetrics' | 'rollup'>;
  now: () => Date;
}

export class AnalyticsTick {
  constructor(private readonly deps: AnalyticsTickDeps) {}

  /** tick.analytics */
  async postMetrics(): Promise<TickResult> {
    const now = this.deps.now();
    const accounts = await this.deps.scanner.dueAccounts(now, ACCOUNTS_PER_TICK);
    const bucket = bucketOf(now);
    const results = await Promise.allSettled(
      accounts.map((account) => this.deps.producer.postMetrics({ ...account, bucket })),
    );
    return {
      accounts: accounts.length,
      enqueueFailed: results.filter((result) => result.status === 'rejected').length,
    };
  }

  /** tick.account-metrics */
  async accountMetrics(): Promise<TickResult> {
    const days = await this.deps.scanner.accountDaysDue(this.deps.now(), ACCOUNTS_PER_TICK);
    const results = await Promise.allSettled(
      days.map((due) => this.deps.producer.accountMetrics(due, spreadDelayMs(due.accountId))),
    );
    return {
      accounts: days.length,
      enqueueFailed: results.filter((result) => result.status === 'rejected').length,
    };
  }

  /** The nightly part of tick.maintenance. */
  async nightlyRollups(): Promise<TickResult> {
    const workspaces = await this.deps.scanner.rollupWorkspaces(this.deps.now());
    const results = await Promise.allSettled(
      workspaces.map(({ organizationId, workspaceId, today }) =>
        this.deps.producer.rollup(
          { organizationId, workspaceId, from: daysBefore(today, NIGHTLY_ROLLUP_DAYS), to: today },
          0,
        ),
      ),
    );
    return {
      rollups: workspaces.length,
      rollupEnqueueFailed: results.filter((result) => result.status === 'rejected').length,
    };
  }
}
