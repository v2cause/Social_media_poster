import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

import { postMetricsJobId } from './job-id';

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

export const metricsRollupSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  day: z.string().regex(DAY),
});
export type MetricsRollup = z.output<typeof metricsRollupSchema>;

const DAY_SECONDS = 24 * 60 * 60;

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

  async accountMetrics(job: MetricsAccount): Promise<void> {
    await this.queue.add(METRICS_ACCOUNT, metricsAccountSchema.parse(job), ANALYTICS_JOB_OPTIONS);
  }

  async rollup(job: MetricsRollup): Promise<void> {
    await this.queue.add(METRICS_ROLLUP, metricsRollupSchema.parse(job), ANALYTICS_JOB_OPTIONS);
  }
}
