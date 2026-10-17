import type { UsageReport } from '@smp/queue';
import { describe, expect, it } from 'vitest';

import { UsageReportTick } from './usage-report-tick';

// Guide step 7.3: after midnight UTC the tick adds one report per organization with unreported
// usage of the days before, spread over half an hour.

const NOW = new Date('2026-10-17T00:07:12Z');

describe('UsageReportTick', () => {
  it('adds a usage report per organization up to the midnight of the day', async () => {
    const reports: [UsageReport, number][] = [];
    const cutoffs: Date[] = [];
    const tick = new UsageReportTick({
      store: {
        organizationsToReport: (until) => {
          cutoffs.push(until);
          return Promise.resolve(['org-1', 'org-2']);
        },
      },
      producer: {
        usageReport: (job, delayMs = 0) => {
          if (job.organizationId === 'org-2') {
            return Promise.reject(new Error('Redis away'));
          }
          reports.push([job, delayMs]);
          return Promise.resolve();
        },
      },
      now: () => NOW,
    });

    await expect(tick.run()).resolves.toEqual({ organizations: 2, enqueueFailed: 1 });
    expect(cutoffs).toEqual([new Date('2026-10-17T00:00:00Z')]);
    expect(reports.map(([job]) => job)).toEqual([{ organizationId: 'org-1', until: '2026-10-17' }]);
    const [[, delay] = []] = reports;
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(30 * 60 * 1000);
  });
});
