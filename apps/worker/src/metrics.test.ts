import type { OperationsCounts } from '@smp/db';
import type { Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { metricsRegistry, publishRunObserver, unwatchOperations, watchOperations } from './metrics';

// Guide step 8.7: the publish runs give the success rate per platform and the delay against the
// schedule; the gauges of the operations read the database and the queues once per interval,
// and stay empty while a reading fails.

const metric = (name: string): Promise<string> => metricsRegistry.getSingleMetricAsString(name);

const counts: OperationsCounts = {
  stuckQueued: 3,
  needsReauth: [{ platform: 'X', connections: 2 }],
  globalFlags: [{ key: 'x_browser_automation', enabled: false }],
  ai24h: {
    generations: 10,
    refusals: 1,
    costMicros: 2_500_000,
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 800,
    cacheWriteTokens: 200,
  },
  xSpend24hMicros: 450_000,
  archiver: {
    archiveMode: true,
    archivedCount: 42,
    failedCount: 0,
    lastArchivedAt: new Date('2026-10-19T03:59:00Z'),
    lastFailedAt: null,
  },
};

describe('the metrics of the worker', () => {
  afterEach(() => {
    unwatchOperations();
    metricsRegistry.resetMetrics();
  });

  it('counts the runs per platform and observes the delay of published ones, not of dry runs', async () => {
    publishRunObserver.runEnded({
      platform: 'X',
      outcome: 'published',
      code: null,
      dryRun: false,
      delayMs: 45_000,
    });
    publishRunObserver.runEnded({
      platform: 'X',
      outcome: 'published',
      code: null,
      dryRun: true,
      delayMs: 1_000,
    });
    publishRunObserver.runEnded({
      platform: 'LINKEDIN',
      outcome: 'failed',
      code: 'MISSED_WINDOW',
      dryRun: false,
      delayMs: 7 * 60 * 60 * 1_000,
    });

    publishRunObserver.runEnded({
      platform: 'X',
      outcome: 'failed',
      code: 'CHALLENGE_REQUIRED',
      dryRun: false,
      delayMs: 10_000,
    });

    expect(await metric('smp_challenges_total')).toContain('smp_challenges_total 1');
    const runs = await metric('smp_publish_runs_total');
    expect(runs).toContain('smp_publish_runs_total{platform="X",outcome="published",code=""} 1');
    expect(runs).toContain('smp_publish_runs_total{platform="X",outcome="dry_run",code=""} 1');
    expect(runs).toContain(
      'smp_publish_runs_total{platform="LINKEDIN",outcome="failed",code="MISSED_WINDOW"} 1',
    );
    const delay = await metric('smp_publish_delay_seconds');
    expect(delay).toContain('smp_publish_delay_seconds_bucket{le="30",platform="X"} 0');
    expect(delay).toContain('smp_publish_delay_seconds_bucket{le="60",platform="X"} 1');
    expect(delay).toContain('smp_publish_delay_seconds_count{platform="X"} 1');
    expect(delay).not.toContain('platform="LINKEDIN"');
  });

  it('reads the operations once per interval and fills the gauges from the reading', async () => {
    const read = vi.fn(() => Promise.resolve(counts));
    watchOperations({
      counts: read,
      storageBytes: () => Promise.resolve(5_000_000),
      queues: [
        {
          name: 'publish',
          getJobCounts: () => Promise.resolve({ waiting: 7, active: 2 }),
          // Due 90 s ago and still delayed: no worker of the queue moved it on.
          getDelayed: () => Promise.resolve([{ timestamp: Date.now() - 120_000, delay: 30_000 }] as Job[]),
        },
        { name: 'media', getJobCounts: () => Promise.resolve({}), getDelayed: () => Promise.resolve([]) },
      ],
      onError: () => undefined,
    });

    const text = await metricsRegistry.metrics();
    await metricsRegistry.metrics();

    expect(read).toHaveBeenCalledTimes(1);
    expect(text).toContain('smp_operations_counts_up 1');
    expect(text).toContain('smp_variants_stuck_queued 3');
    expect(text).toContain('smp_connections_needs_reauth{platform="X"} 2');
    expect(text).toContain('smp_kill_switch_active{key="x_browser_automation"} 1');
    expect(text).toContain('smp_ai_cost_usd_24h 2.5');
    expect(text).toContain('smp_ai_generations_24h{outcome="refused"} 1');
    expect(text).toContain('smp_ai_tokens_24h{kind="cache_read"} 800');
    expect(text).toContain('smp_x_spend_usd_24h 0.45');
    expect(text).toContain('smp_pg_archiver{field="last_archived_timestamp_seconds"} 1792382340');
    expect(text).toContain('smp_media_storage_bytes 5000000');
    expect(text).toContain('smp_queue_counts_up 1');
    expect(text).toContain('smp_queue_jobs{queue="publish",state="waiting"} 7');
    expect(text).toContain('smp_queue_jobs{queue="publish",state="delayed"} 0');
    expect(text).toMatch(/smp_queue_overdue_seconds\{queue="publish"\} 90(\.\d+)?\n/);
    expect(text).toContain('smp_queue_overdue_seconds{queue="media"} 0');
  });

  it('says so while a reading fails and leaves the gauges with labels empty', async () => {
    const errors: string[] = [];
    watchOperations({
      counts: () => Promise.reject(new Error('database down')),
      storageBytes: () => Promise.reject(new Error('database down')),
      queues: [],
      onError: (_error, reading) => errors.push(reading),
    });

    const text = await metricsRegistry.metrics();

    expect(text).toContain('smp_operations_counts_up 0');
    expect(text).toContain('smp_queue_counts_up 1');
    expect(text).not.toMatch(/^smp_connections_needs_reauth\{/m);
    expect(text).not.toMatch(/^smp_pg_archiver\{/m);
    expect(errors).toEqual(expect.arrayContaining(['counts', 'storage']));
  });

  it('leaves out the gauges of the operations outside the role scheduler', async () => {
    const text = await metricsRegistry.metrics();

    expect(text).not.toContain('smp_operations_counts_up');
    expect(text).not.toContain('smp_variants_stuck_queued');
    expect(text).not.toContain('smp_queue_jobs');
  });
});
