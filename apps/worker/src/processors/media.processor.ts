import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import {
  RenditionNotPossibleError,
  type DropUpload,
  type DropUploadOutcome,
  type ProcessAsset,
  type ProcessOutcome,
  type RenderAttachedMedia,
  type RenderJobOutcome,
} from '@smp/core';
import {
  MEDIA_DROP_UPLOAD,
  MEDIA_PROCESS,
  MEDIA_QUEUE,
  MEDIA_RENDER,
  parseMediaProcess,
  parseMediaRender,
} from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import { jobsTotal } from '../metrics';
import { DROP_UPLOAD, PROCESS_ASSET, RENDER_ATTACHED_MEDIA } from '../worker.tokens';

/** Images decoded at the same time per worker process; each one may take a few hundred MB. */
export const MEDIA_CONCURRENCY = 2;

/**
 * The jobs of the queue "media" (guide steps 3.3 and 3.4, architecture 9). media.process checks
 * an upload: magic bytes, decoder with pixel limit, thumbnails. A refused image is an outcome,
 * not a failure. media.render makes the rendition of an attached image for its platform.
 * media.drop-upload deletes the upload object an hour after the link of the ticket expired (guide
 * step 8.4). Only storage or database errors are retried by BullMQ. Logs carry ids, never file
 * names.
 */
@Processor(MEDIA_QUEUE, { concurrency: MEDIA_CONCURRENCY })
export class MediaProcessor extends WorkerHost {
  constructor(
    @Inject(PROCESS_ASSET) private readonly processAsset: ProcessAsset,
    @Inject(RENDER_ATTACHED_MEDIA) private readonly renderAttachedMedia: RenderAttachedMedia,
    @Inject(DROP_UPLOAD) private readonly dropUpload: DropUpload,
    @InjectPinoLogger(MediaProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  process(job: Job): Promise<ProcessOutcome | RenderJobOutcome | DropUploadOutcome> {
    if (job.name === MEDIA_PROCESS) {
      const payload = this.parse(job, parseMediaProcess);
      return this.run(job, payload.assetId, () => this.processAsset.execute(payload));
    }
    if (job.name === MEDIA_DROP_UPLOAD) {
      const payload = this.parse(job, parseMediaProcess);
      return this.run(job, payload.assetId, () => this.dropUpload.execute(payload));
    }
    if (job.name === MEDIA_RENDER) {
      const payload = this.parse(job, parseMediaRender);
      return this.run(job, payload.assetId, async () => {
        try {
          return await this.renderAttachedMedia.execute(payload);
        } catch (error) {
          // The attachment was checked when it was saved; retrying cannot change the outcome.
          if (error instanceof RenditionNotPossibleError) {
            throw new UnrecoverableError(`rendition not possible: ${error.issue}`);
          }
          throw error;
        }
      });
    }
    throw new UnrecoverableError(`unknown job ${job.name}`);
  }

  private parse<T>(job: Job, parse: (data: unknown) => T): T {
    try {
      return parse(job.data);
    } catch (error) {
      if (error instanceof ZodError) {
        this.logger.error({ jobId: job.id, job: job.name }, 'media.invalid_payload');
        jobsTotal.inc({ queue: MEDIA_QUEUE, status: 'invalid' });
        throw new UnrecoverableError(`invalid ${job.name} payload`);
      }
      throw error;
    }
  }

  private async run<T extends string>(job: Job, assetId: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let outcome: T;
    try {
      outcome = await work();
    } catch (error) {
      jobsTotal.inc({ queue: MEDIA_QUEUE, status: 'failed' });
      this.logger.warn(
        { jobId: job.id, job: job.name, assetId, attempt: job.attemptsMade + 1, err: error },
        'media.job_failed',
      );
      throw error;
    }
    jobsTotal.inc({ queue: MEDIA_QUEUE, status: 'completed' });
    this.logger.info(
      { jobId: job.id, job: job.name, assetId, outcome, durationMs: Date.now() - started },
      'media.job_done',
    );
    return outcome;
  }
}
