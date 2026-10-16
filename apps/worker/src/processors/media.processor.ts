import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { ProcessAsset, ProcessOutcome } from '@smp/core';
import { MEDIA_PROCESS, MEDIA_QUEUE, parseMediaProcess } from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import { jobsTotal } from '../metrics';
import { PROCESS_ASSET } from '../worker.tokens';

/** Images decoded at the same time per worker process; each one may take a few hundred MB. */
export const MEDIA_CONCURRENCY = 2;

/**
 * Checks and processes uploaded media (guide step 3.3, architecture 9): magic bytes, decoder
 * with pixel limit, thumbnails. A refused image is an outcome, not a failure; only storage or
 * database errors are retried by BullMQ. Logs carry ids, never file names.
 */
@Processor(MEDIA_QUEUE, { concurrency: MEDIA_CONCURRENCY })
export class MediaProcessor extends WorkerHost {
  constructor(
    @Inject(PROCESS_ASSET) private readonly processAsset: ProcessAsset,
    @InjectPinoLogger(MediaProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<ProcessOutcome> {
    if (job.name !== MEDIA_PROCESS) {
      throw new UnrecoverableError(`unknown job ${job.name}`);
    }
    let payload;
    try {
      payload = parseMediaProcess(job.data);
    } catch (error) {
      if (error instanceof ZodError) {
        this.logger.error({ jobId: job.id }, 'media.invalid_payload');
        jobsTotal.inc({ queue: MEDIA_QUEUE, status: 'invalid' });
        throw new UnrecoverableError('invalid media.process payload');
      }
      throw error;
    }
    const started = Date.now();
    let outcome: ProcessOutcome;
    try {
      outcome = await this.processAsset.execute(payload);
    } catch (error) {
      jobsTotal.inc({ queue: MEDIA_QUEUE, status: 'failed' });
      this.logger.warn(
        { jobId: job.id, assetId: payload.assetId, attempt: job.attemptsMade + 1, err: error },
        'media.process_failed',
      );
      throw error;
    }
    jobsTotal.inc({ queue: MEDIA_QUEUE, status: 'completed' });
    this.logger.info(
      { jobId: job.id, assetId: payload.assetId, outcome, durationMs: Date.now() - started },
      'media.processed',
    );
    return outcome;
  }
}
