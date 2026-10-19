import type { PublishRunObserver } from '@smp/core';
import type { OperationsCounts } from '@smp/db';
import type { Queue } from 'bullmq';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// The metrics of the worker on /metrics of its health port (architecture 12, guide step 8.7).
// Counters and histograms come from the jobs of this process. The gauges of the operations read
// the database and the queues when Prometheus scrapes, in the role "scheduler" only, and keep a
// reading for a while, so that several replicas and scrapes do not add load. Labels name queues,
// platforms, outcomes and codes, never a tenant.

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

export const jobsTotal = new Counter({
  name: 'smp_worker_jobs_total',
  help: 'Jobs handled by this worker, by queue and outcome',
  labelNames: ['queue', 'status'] as const,
  registers: [metricsRegistry],
});

/** Publish jobs that failed for good; the alarm "dead-letter queue not empty" watches it. */
export const publishDeadLettersTotal = new Counter({
  name: 'smp_worker_publish_dead_letters_total',
  help: 'Publish jobs that failed for good and went to the dead-letter queue',
  registers: [metricsRegistry],
});

export const publishRunsTotal = new Counter({
  name: 'smp_publish_runs_total',
  help: 'Runs of the publish job that ended, by platform, outcome and failure code',
  labelNames: ['platform', 'outcome', 'code'] as const,
  registers: [metricsRegistry],
});

/** The SLO of guide step 8.7: 99 % of the variants go out within two minutes of their time. */
export const publishDelaySeconds = new Histogram({
  name: 'smp_publish_delay_seconds',
  help: 'Time between the scheduled time of a variant and its publication, by platform',
  labelNames: ['platform'] as const,
  buckets: [5, 15, 30, 60, 120, 300, 900, 3_600, 21_600],
  registers: [metricsRegistry],
});

/** Counts the runs of the publish job; a dry run is no publication. */
export const publishRunObserver: PublishRunObserver = {
  runEnded(report) {
    const outcome = report.outcome === 'published' && report.dryRun ? 'dry_run' : report.outcome;
    publishRunsTotal.inc({ platform: report.platform, outcome, code: report.code ?? '' });
    if (report.code === 'CHALLENGE_REQUIRED') {
      challengesTotal.inc();
    }
    if (outcome === 'published' && report.delayMs !== null) {
      publishDelaySeconds.observe({ platform: report.platform }, Math.max(0, report.delayMs) / 1_000);
    }
  },
};

export const tickLastSuccess = new Gauge({
  name: 'smp_scheduler_tick_last_success_timestamp_seconds',
  help: 'When a tick of the scheduler last ended without an error, as a Unix time',
  labelNames: ['tick'] as const,
  registers: [metricsRegistry],
});

/** Later than the last success means the last run failed; a failed tick waits for its next time. */
export const tickLastFailure = new Gauge({
  name: 'smp_scheduler_tick_last_failure_timestamp_seconds',
  help: 'When a tick of the scheduler last failed, as a Unix time',
  labelNames: ['tick'] as const,
  registers: [metricsRegistry],
});

export const tickLagSeconds = new Gauge({
  name: 'smp_scheduler_tick_lag_seconds',
  help: 'How late the last run of a tick started against its schedule',
  labelNames: ['tick'] as const,
  registers: [metricsRegistry],
});

export const tokenRefreshTotal = new Counter({
  name: 'smp_token_refresh_total',
  help: 'Token refresh jobs by outcome; error is a job that failed and may try again',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});
// A series of a counter appears with its first event, which increase() does not see; the alerts
// on rare events read series that exist from the start.
for (const outcome of ['refreshed', 'expiring', 'unchanged', 'reauth', 'skipped', 'error']) {
  tokenRefreshTotal.inc({ outcome }, 0);
}

export const xbReportsTotal = new Counter({
  name: 'smp_xbrowser_reports_total',
  help: 'Reports of the browser worker by kind and the result of handling them',
  labelNames: ['kind', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const xbLoginFailuresTotal = new Counter({
  name: 'smp_xbrowser_login_failures_total',
  help: 'Logins of the X browser that ended without a connection, by reason',
  labelNames: ['failure'] as const,
  registers: [metricsRegistry],
});

/** Rare events of the X browser that alert (runbook X-Drift); counted from zero on. */
export const xbDriftsTotal = new Counter({
  name: 'smp_xbrowser_drifts_total',
  help: 'Selector drifts the browser worker reported',
  registers: [metricsRegistry],
});

export const xbCanaryFailuresTotal = new Counter({
  name: 'smp_xbrowser_canary_failures_total',
  help: 'Runs of the canary of the X browser that missed selectors',
  registers: [metricsRegistry],
});

/** A challenge of the platform: at a post (failure code CHALLENGE_REQUIRED) or at a login. */
export const challengesTotal = new Counter({
  name: 'smp_challenges_total',
  help: 'Challenges of a platform that stopped a post or a login',
  registers: [metricsRegistry],
});

/** Where the gauges of the operations read from; set by the role "scheduler". */
export interface OperationsSource {
  counts: () => Promise<OperationsCounts>;
  storageBytes: () => Promise<number>;
  queues: readonly Pick<Queue, 'name' | 'getJobCounts' | 'getDelayed'>[];
  /** Hears of a reading that failed; the gauges then stay empty until the next one works. */
  onError: (error: unknown, reading: string) => void;
}

const COUNTS_TTL_MS = 30_000;
const STORAGE_TTL_MS = 5 * 60_000;
const QUEUES_TTL_MS = 15_000;
const QUEUE_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'failed', 'paused'] as const;
const MICROS_PER_USD = 1_000_000;

/** The last reading of work for ttlMs; a failed reading counts as none and is tried again. */
function cachedReading<T>(ttlMs: number, read: () => Promise<T>, onError: (error: unknown) => void) {
  let reading: { at: number; value: Promise<T | null> } | null = null;
  return (now = Date.now()): Promise<T | null> => {
    if (!reading || now - reading.at >= ttlMs) {
      const value = read().catch((error: unknown) => {
        onError(error);
        reading = null;
        return null;
      });
      reading = { at: now, value };
    }
    return reading.value;
  };
}

interface QueueReading {
  queue: string;
  counts: Record<string, number>;
  overdueSeconds: number;
}

interface OperationsReadings {
  counts: () => Promise<OperationsCounts | null>;
  storageBytes: () => Promise<number | null>;
  queues: () => Promise<QueueReading[] | null>;
}

/**
 * How long the earliest delayed job is past its time. BullMQ moves a due job on only in a worker of
 * its queue, so without one the job stays delayed and never counts as waiting (guide step 8.7).
 */
const overdueSecondsOf = (earliest: readonly { timestamp: number; delay: number }[], now: number): number => {
  const [job] = earliest;
  return job ? Math.max(0, now - (job.timestamp + job.delay)) / 1_000 : 0;
};

const seconds = (date: Date | null): number => (date ? date.getTime() / 1_000 : 0);

/**
 * The gauges of the operations, registered only in the role "scheduler", so that no other
 * process reports a value it does not measure. Each one fills itself from the readings when
 * Prometheus scrapes; a gauge with labels stays empty while its reading fails.
 */
function registerOperationsGauges(readings: OperationsReadings): string[] {
  const fromCounts = <L extends string>(
    name: string,
    help: string,
    labelNames: readonly L[],
    fill: (gauge: Gauge<L>, counts: OperationsCounts) => void,
  ) =>
    new Gauge({
      name,
      help,
      labelNames,
      registers: [metricsRegistry],
      async collect() {
        this.reset();
        const counts = await readings.counts();
        if (counts) {
          fill(this, counts);
        }
      },
    });
  const gauges = [
    new Gauge({
      name: 'smp_operations_counts_up',
      help: 'Whether the last reading of the operations counts worked',
      registers: [metricsRegistry],
      async collect() {
        this.set((await readings.counts()) ? 1 : 0);
      },
    }),
    fromCounts(
      'smp_variants_stuck_queued',
      'QUEUED variants whose job did not start within ten minutes',
      [],
      (g, c) => {
        g.set(c.stuckQueued);
      },
    ),
    fromCounts(
      'smp_connections_needs_reauth',
      'Connections that need a new login, by platform',
      ['platform'],
      (g, c) => {
        for (const row of c.needsReauth) {
          g.set({ platform: row.platform }, row.connections);
        }
      },
    ),
    fromCounts(
      'smp_kill_switch_active',
      'Whether a kill switch is on, by the key of its global flag',
      ['key'],
      (g, c) => {
        for (const flag of c.globalFlags) {
          g.set({ key: flag.key }, flag.enabled ? 0 : 1);
        }
      },
    ),
    fromCounts(
      'smp_ai_generations_24h',
      'AI generations of the last 24 hours, and of them the refusals',
      ['outcome'],
      (g, c) => {
        g.set({ outcome: 'all' }, c.ai24h.generations);
        g.set({ outcome: 'refused' }, c.ai24h.refusals);
      },
    ),
    fromCounts('smp_ai_cost_usd_24h', 'Cost of the AI in the last 24 hours, in USD', [], (g, c) => {
      g.set(c.ai24h.costMicros / MICROS_PER_USD);
    }),
    fromCounts('smp_ai_tokens_24h', 'Tokens of the AI in the last 24 hours, by kind', ['kind'], (g, c) => {
      g.set({ kind: 'input' }, c.ai24h.inputTokens);
      g.set({ kind: 'output' }, c.ai24h.outputTokens);
      g.set({ kind: 'cache_read' }, c.ai24h.cacheReadTokens);
      g.set({ kind: 'cache_write' }, c.ai24h.cacheWriteTokens);
    }),
    fromCounts('smp_x_spend_usd_24h', 'Spend on the X API in the last 24 hours, in USD', [], (g, c) => {
      g.set(c.xSpend24hMicros / MICROS_PER_USD);
    }),
    fromCounts('smp_pg_archiver', 'State of the WAL archiver of PostgreSQL', ['field'], (g, c) => {
      g.set({ field: 'archive_mode' }, c.archiver.archiveMode ? 1 : 0);
      g.set({ field: 'archived_count' }, c.archiver.archivedCount);
      g.set({ field: 'failed_count' }, c.archiver.failedCount);
      g.set({ field: 'last_archived_timestamp_seconds' }, seconds(c.archiver.lastArchivedAt));
      g.set({ field: 'last_failed_timestamp_seconds' }, seconds(c.archiver.lastFailedAt));
    }),
    new Gauge({
      name: 'smp_media_storage_bytes',
      help: 'Bytes of the media library, without deleted and rejected files',
      registers: [metricsRegistry],
      async collect() {
        this.reset();
        const bytes = await readings.storageBytes();
        if (bytes !== null) {
          this.set(bytes);
        }
      },
    }),
    new Gauge({
      name: 'smp_queue_counts_up',
      help: 'Whether the last reading of the queues in Redis worked',
      registers: [metricsRegistry],
      async collect() {
        this.set((await readings.queues()) ? 1 : 0);
      },
    }),
    new Gauge({
      name: 'smp_queue_jobs',
      help: 'Jobs in a queue of BullMQ, by state',
      labelNames: ['queue', 'state'] as const,
      registers: [metricsRegistry],
      async collect() {
        this.reset();
        for (const { queue, counts } of (await readings.queues()) ?? []) {
          for (const state of QUEUE_STATES) {
            this.set({ queue, state }, counts[state] ?? 0);
          }
        }
      },
    }),
    new Gauge({
      name: 'smp_queue_overdue_seconds',
      help: 'How long the earliest delayed job of a queue is past its time; it grows without a worker',
      labelNames: ['queue'] as const,
      registers: [metricsRegistry],
      async collect() {
        this.reset();
        for (const { queue, overdueSeconds } of (await readings.queues()) ?? []) {
          this.set({ queue }, overdueSeconds);
        }
      },
    }),
  ];
  return gauges.map((gauge) => (gauge as unknown as { name: string }).name);
}

let watched: string[] = [];

/** Registers the gauges of the operations with their source; the role "scheduler" calls it once. */
export function watchOperations(source: OperationsSource): void {
  unwatchOperations();
  watched = registerOperationsGauges({
    counts: cachedReading(COUNTS_TTL_MS, source.counts, (error) => {
      source.onError(error, 'counts');
    }),
    storageBytes: cachedReading(STORAGE_TTL_MS, source.storageBytes, (error) => {
      source.onError(error, 'storage');
    }),
    queues: cachedReading(
      QUEUES_TTL_MS,
      () =>
        Promise.all(
          source.queues.map(async (queue) => ({
            queue: queue.name,
            counts: await queue.getJobCounts(...QUEUE_STATES),
            overdueSeconds: overdueSecondsOf(await queue.getDelayed(0, 0), Date.now()),
          })),
        ),
      (error) => {
        source.onError(error, 'queues');
      },
    ),
  });
}

/** Removes the gauges of the operations, for example when the role shuts down. */
export function unwatchOperations(): void {
  for (const name of watched) {
    metricsRegistry.removeSingleMetric(name);
  }
  watched = [];
}
