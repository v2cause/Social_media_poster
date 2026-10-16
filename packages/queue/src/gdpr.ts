import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

import { gdprJobId } from './job-id';

// Queue "gdpr" (architecture 7.4 and 10), processed by the worker role "gdpr" from phase 8: data
// exports and erasures, one job per request.

export const GDPR_QUEUE = 'gdpr';
export const GDPR_EXPORT = 'gdpr.export';
export const GDPR_ERASE = 'gdpr.erase';

export const gdprRequestSchema = z.object({ requestId: z.uuid() });
export type GdprRequest = z.output<typeof gdprRequestSchema>;

const DAY_SECONDS = 24 * 60 * 60;

export const GDPR_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: { age: DAY_SECONDS },
  removeOnFail: { age: 7 * DAY_SECONDS },
};

export const parseGdprRequest = (data: unknown): GdprRequest => gdprRequestSchema.parse(data);

export class GdprProducer {
  constructor(private readonly queue: Queue) {}

  async exportData(job: GdprRequest): Promise<void> {
    const payload = gdprRequestSchema.parse(job);
    await this.queue.add(GDPR_EXPORT, payload, { ...GDPR_JOB_OPTIONS, jobId: gdprJobId(payload.requestId) });
  }

  async erase(job: GdprRequest): Promise<void> {
    const payload = gdprRequestSchema.parse(job);
    await this.queue.add(GDPR_ERASE, payload, { ...GDPR_JOB_OPTIONS, jobId: gdprJobId(payload.requestId) });
  }
}
