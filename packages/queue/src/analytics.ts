import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

import { accountMetricsJobId, postMetricsJobId, rollupKey } from './job-id';

// Queue "analytics" (architecture 7.4 and 8), processed by the worker role "analytics" from
// phase 5: the metrics of posts, batched per account and time bucket, the daily account metrics
// and the rollups.

export const ANALYTICS_QUEUE = 'analytics';
export const METRICS_POST = 'metrics.post';
export const METRICS_ACCOUNT = 'metrics.account';
export const METRICS_ROLLUP = 'metrics.rollup';

const BUCKET = /^[A-Za-z0-9_-]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const metricsPostSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  // The time bucket of the tick, for example 202610161500.
  bucket: z.string().regex(BUCKET),
});
export type MetricsPost = z.output<typeof metricsPostSchema>;

export const metricsAccountSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  day: z.string().regex(DAY),
});
export type MetricsAccount = z.output<typeof metricsAccountSchema>;

/** The local days from `from` to `to`, both included. */
export const metricsRollupSchema = z
  .object({
    organizationId: z.uuid(),
    workspaceId: z.uuid(),
    from: z.string().regex(DAY),
    to: z.string().regex(DAY),
  })
  .refine((rollup) => rollup.from <= rollup.to, { message: 'from must not be after to' });
export type MetricsRollup = z.output<typeof metricsRollupSchema>;

const DAY_SECONDS = 24 * 60 * 60;
/** The collector runs of a tick end close together; their rollups wait a little and merge. */
const ROLLUP_DELAY_MS = 10_000;

export const ANALYTICS_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: true,
  removeOnFail: { age: DAY_SECONDS },
};

export const parseMetricsPost = (data: unknown): MetricsPost => metricsPostSchema.parse(data);
export const parseMetricsAccount = (data: unknown): MetricsAccount => metricsAccountSchema.parse(data);
export const parseMetricsRollup = (data: unknown): MetricsRollup => metricsRollupSchema.parse(data);

export class AnalyticsProducer {
  constructor(private readonly queue: Queue) {}

  async postMetrics(job: MetricsPost): Promise<void> {
    const payload = metricsPostSchema.parse(job);
    await this.queue.add(METRICS_POST, payload, {
      ...ANALYTICS_JOB_OPTIONS,
      jobId: postMetricsJobId(payload.accountId, payload.bucket),
    });
  }

  /** Once per account and day; the delay spreads the accounts of a tick over the hour. */
  async accountMetrics(job: MetricsAccount, delayMs = 0): Promise<void> {
    const payload = metricsAccountSchema.parse(job);
    await this.queue.add(METRICS_ACCOUNT, payload, {
      ...ANALYTICS_JOB_OPTIONS,
      jobId: accountMetricsJobId(payload.accountId, payload.day),
      delay: delayMs,
    });
  }

  /**
   * A rollup of the days. While one for the same days waits, another request adds nothing; while
   * one runs, one more follows it, so the numbers written after its start are rolled up too.
   */
  async rollup(job: MetricsRollup, delayMs = ROLLUP_DELAY_MS): Promise<void> {
    const payload = metricsRollupSchema.parse(job);
    await this.queue.add(METRICS_ROLLUP, payload, {
      ...ANALYTICS_JOB_OPTIONS,
      delay: delayMs,
      deduplication: {
        id: rollupKey(payload.workspaceId, payload.from, payload.to),
        keepLastIfActive: true,
      },
    });
  }
}
