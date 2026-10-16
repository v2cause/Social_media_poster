import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

// Queue "media", job "media.process" (architecture 7.4, guide step 3.3), processed by the worker
// role "media". The payload holds only ids; the worker reads the asset again from the database.
// It is validated when it is added and again when it is processed.

export const MEDIA_QUEUE = 'media';
export const MEDIA_PROCESS = 'media.process';

export const mediaProcessSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  assetId: z.uuid(),
});
export type MediaProcess = z.output<typeof mediaProcessSchema>;

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Retries for a storage or database that is briefly away (about 5 s, 10 s, 20 s, 40 s). An image
 * the pipeline refuses is no failure: the job completes with a rejected asset.
 */
export const MEDIA_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: DAY_SECONDS },
};

/** One job per asset: adding it again while it waits or runs changes nothing. */
export const mediaProcessJobId = (assetId: string): string => `media.${assetId}`;

/** Validates a job payload. Throws a ZodError for anything else. */
export const parseMediaProcess = (data: unknown): MediaProcess => mediaProcessSchema.parse(data);

/** Typed producer of the media queue for the API; implements the MediaJobs port of the core. */
export class MediaProducer {
  constructor(private readonly queue: Queue) {}

  async process(job: MediaProcess): Promise<void> {
    const payload = mediaProcessSchema.parse(job);
    await this.queue.add(MEDIA_PROCESS, payload, {
      ...MEDIA_JOB_OPTIONS,
      jobId: mediaProcessJobId(payload.assetId),
    });
  }
}
