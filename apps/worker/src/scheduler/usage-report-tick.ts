import { reportCutoffOf, type UsageReportStore } from '@smp/core';
import type { BillingProducer } from '@smp/queue';

import type { TickResult } from '../processors/scheduler.processor';
import { spreadDelayMs } from './analytics-tick';

// tick.usage-report (guide step 7.3): once a day after midnight UTC, one job usage.report per
// organization whose billed usage of the days before was not reported yet; the role "billing"
// sends it to Stripe. Its id names the organization and the day, so the tick of a day adds each
// job once, and the jobs spread over half an hour.

/** The reports of a day spread over this much time. */
const REPORT_SPREAD_MS = 30 * 60 * 1000;

interface UsageReportTickDeps {
  store: Pick<UsageReportStore, 'organizationsToReport'>;
  producer: Pick<BillingProducer, 'usageReport'>;
  now: () => Date;
}

export class UsageReportTick {
  constructor(private readonly deps: UsageReportTickDeps) {}

  async run(): Promise<TickResult> {
    const until = reportCutoffOf(this.deps.now());
    const day = until.toISOString().slice(0, 10);
    const organizations = await this.deps.store.organizationsToReport(until);
    const results = await Promise.allSettled(
      organizations.map((organizationId) =>
        this.deps.producer.usageReport(
          { organizationId, until: day },
          spreadDelayMs(organizationId, REPORT_SPREAD_MS),
        ),
      ),
    );
    return {
      organizations: organizations.length,
      enqueueFailed: results.filter((result) => result.status === 'rejected').length,
    };
  }
}
