import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

import { gdprJobId, gdprSweepJobId } from './job-id';

// Queue "gdpr" (architecture 7.4 and 10), processed by the worker role "gdpr" from phase 8: data
// exports and erasures, one job per request, and the hourly sweep that deletes the archives of
// expired exports (tick.gdpr).

export const GDPR_QUEUE = 'gdpr';
export const GDPR_EXPORT = 'gdpr.export';
export const GDPR_ERASE = 'gdpr.erase';
export const GDPR_SWEEP = 'gdpr.sweep';

export const gdprJobSchema = z.object({ requestId: z.uuid() });
export type GdprJob = z.output<typeof gdprJobSchema>;

/** The sweep carries nothing; the worker reads what is due. */
export const gdprSweepSchema = z.object({}).strict();

const DAY_SECONDS = 24 * 60 * 60;

export const GDPR_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: { age: DAY_SECONDS },
  removeOnFail: { age: 7 * DAY_SECONDS },
};

/**
 * One sweep at a time: the job is removed when it ends, so the next tick can add the next one,
 * and a sweep that waits for a worker is not added twice.
 */
export const GDPR_SWEEP_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
};

export const parseGdprJob = (data: unknown): GdprJob => gdprJobSchema.parse(data);
export const parseGdprSweep = (data: unknown): void => {
  gdprSweepSchema.parse(data);
};

export class GdprProducer {
  constructor(private readonly queue: Queue) {}

  async exportData(job: GdprJob): Promise<void> {
    const payload = gdprJobSchema.parse(job);
    await this.queue.add(GDPR_EXPORT, payload, { ...GDPR_JOB_OPTIONS, jobId: gdprJobId(payload.requestId) });
  }

  async erase(job: GdprJob): Promise<void> {
    const payload = gdprJobSchema.parse(job);
    await this.queue.add(GDPR_ERASE, payload, { ...GDPR_JOB_OPTIONS, jobId: gdprJobId(payload.requestId) });
  }

  async sweep(): Promise<void> {
    await this.queue.add(GDPR_SWEEP, {}, { ...GDPR_SWEEP_JOB_OPTIONS, jobId: gdprSweepJobId() });
  }
}
