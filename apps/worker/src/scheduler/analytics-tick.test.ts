import type { DueAccountDay, DueMetricsAccount } from '@smp/core';
import type { MetricsAccount, MetricsPost, MetricsRollup } from '@smp/queue';
import { describe, expect, it } from 'vitest';

import { AnalyticsTick, bucketOf, spreadDelayMs } from './analytics-tick';

// Guide step 5.2: the planner adds one metrics job per account with due polls and one daily job
// per account whose numbers of the day before are missing, spread over the hour.

const NOW = new Date('2026-10-16T15:05:42Z');
const account = (id: string): DueMetricsAccount => ({
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  accountId: id,
});

describe('AnalyticsTick', () => {
  it('adds a metrics job per account with the bucket of the tick', async () => {
    const posts: MetricsPost[] = [];
    const tick = new AnalyticsTick({
      scanner: {
        dueAccounts: () => Promise.resolve([account('a1'), account('a2')]),
        accountDaysDue: () => Promise.resolve([]),
        rollupWorkspaces: () => Promise.resolve([]),
      },
      producer: {
        postMetrics: (job) => {
          posts.push(job);
          return Promise.resolve();
        },
        accountMetrics: () => Promise.resolve(),
        rollup: () => Promise.resolve(),
      },
      now: () => NOW,
    });

    await expect(tick.postMetrics()).resolves.toEqual({ accounts: 2, enqueueFailed: 0 });
    expect(posts).toEqual([
      { ...account('a1'), bucket: '202610161505' },
      { ...account('a2'), bucket: '202610161505' },
    ]);
  });

  it('spreads the daily polls over the hour and counts what it could not add', async () => {
    const days: DueAccountDay[] = [
      { ...account('a1'), day: '2026-10-15' },
      { ...account('a2'), day: '2026-10-15' },
    ];
    const added: [MetricsAccount, number | undefined][] = [];
    const tick = new AnalyticsTick({
      scanner: {
        dueAccounts: () => Promise.resolve([]),
        accountDaysDue: () => Promise.resolve(days),
        rollupWorkspaces: () => Promise.resolve([]),
      },
      producer: {
        postMetrics: () => Promise.resolve(),
        rollup: () => Promise.resolve(),
        accountMetrics: (job, delayMs) => {
          if (job.accountId === 'a2') {
            return Promise.reject(new Error('Redis is away'));
          }
          added.push([job, delayMs]);
          return Promise.resolve();
        },
      },
      now: () => NOW,
    });

    await expect(tick.accountMetrics()).resolves.toEqual({ accounts: 2, enqueueFailed: 1 });
    expect(added).toEqual([[days[0], spreadDelayMs('a1')]]);
  });

  it('rolls the last 35 days of every workspace up at night, without delay', async () => {
    const rollups: [MetricsRollup, number | undefined][] = [];
    const tick = new AnalyticsTick({
      scanner: {
        dueAccounts: () => Promise.resolve([]),
        accountDaysDue: () => Promise.resolve([]),
        rollupWorkspaces: () =>
          Promise.resolve([{ organizationId: 'org-1', workspaceId: 'ws-1', today: '2026-10-16' }]),
      },
      producer: {
        postMetrics: () => Promise.resolve(),
        accountMetrics: () => Promise.resolve(),
        rollup: (job, delayMs) => {
          rollups.push([job, delayMs]);
          return Promise.resolve();
        },
      },
      now: () => NOW,
    });

    await expect(tick.nightlyRollups()).resolves.toEqual({ rollups: 1, rollupEnqueueFailed: 0 });
    expect(rollups).toEqual([
      [{ organizationId: 'org-1', workspaceId: 'ws-1', from: '2026-09-11', to: '2026-10-16' }, 0],
    ]);
  });

  it('builds the bucket from the minute of the tick and keeps the spread stable and inside the hour', () => {
    expect(bucketOf(NOW)).toBe('202610161505');
    expect(spreadDelayMs('account-1')).toBe(spreadDelayMs('account-1'));
    for (const id of ['a', 'account-1', '0192f5d4-0000-7000-8000-000000000001']) {
      expect(spreadDelayMs(id)).toBeGreaterThanOrEqual(0);
      expect(spreadDelayMs(id)).toBeLessThan(50 * 60 * 1000);
    }
  });
});
