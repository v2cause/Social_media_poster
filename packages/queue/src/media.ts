import { RENDITION_PROFILE_KEYS } from '@smp/platform-rules';
import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

// Queue "media" with the jobs "media.process" (guide step 3.3), "media.render" (step 3.4) and
// "media.drop-upload" (step 8.4), architecture 7.4, processed by the worker role "media". The
// payloads hold only ids and keys; the worker reads everything else again from the database. They
// are validated when they are added and again when they are processed.

export const MEDIA_QUEUE = 'media';
export const MEDIA_PROCESS = 'media.process';
export const MEDIA_RENDER = 'media.render';
export const MEDIA_DROP_UPLOAD = 'media.drop-upload';

export const mediaProcessSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  assetId: z.uuid(),
});
export type MediaProcess = z.output<typeof mediaProcessSchema>;

export const mediaRenderSchema = mediaProcessSchema.extend({
  postMediaId: z.uuid(),
  profile: z.enum(RENDITION_PROFILE_KEYS),
  // The crop hash of the core: "full", "x0y120w1080h1350", optionally with "-lb".
  cropHash: z.string().regex(/^[a-z0-9-]{1,80}$/),
});
export type MediaRender = z.output<typeof mediaRenderSchema>;

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

/** One job per asset, profile and crop (architecture 7.4). */
export const mediaRenderJobId = (job: Pick<MediaRender, 'assetId' | 'profile' | 'cropHash'>): string =>
  `rend.${job.assetId}.${job.profile}.${job.cropHash}`;

/** One job per upload ticket, which is one asset. */
export const mediaDropUploadJobId = (assetId: string): string => `drop.${assetId}`;

const delaySecondsSchema = z.number().int().nonnegative();

/** Validates a job payload. Throws a ZodError for anything else. */
export const parseMediaProcess = (data: unknown): MediaProcess => mediaProcessSchema.parse(data);
export const parseMediaRender = (data: unknown): MediaRender => mediaRenderSchema.parse(data);

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

  async render(job: MediaRender): Promise<void> {
    const payload = mediaRenderSchema.parse(job);
    await this.queue.add(MEDIA_RENDER, payload, { ...MEDIA_JOB_OPTIONS, jobId: mediaRenderJobId(payload) });
  }

  /** The payload is the one of media.process: the asset of the ticket. */
  async dropUpload(job: MediaProcess, delaySeconds: number): Promise<void> {
    const payload = mediaProcessSchema.parse(job);
    await this.queue.add(MEDIA_DROP_UPLOAD, payload, {
      ...MEDIA_JOB_OPTIONS,
      jobId: mediaDropUploadJobId(payload.assetId),
      delay: delaySecondsSchema.parse(delaySeconds) * 1000,
    });
  }
}
