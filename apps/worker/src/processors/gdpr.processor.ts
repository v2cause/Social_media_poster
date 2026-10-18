import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { systemClock, type ErasureResult, type ExportResult } from '@smp/core';
import { GDPR_ERASE, GDPR_EXPORT, GDPR_QUEUE, GDPR_SWEEP, parseGdprJob, parseGdprSweep } from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import type { GdprPipeline } from '../infrastructure/gdpr.providers';
import { jobsTotal } from '../metrics';
import { GDPR_PIPELINE } from '../worker.tokens';

/** What the sweep did. */
interface SweepResult {
  exportsExpired: number;
  exportsTimedOut: number;
  erasuresQueued: number;
  mediaDeleted: number;
  mediaObjectsDeleted: number;
}

/**
 * The jobs of the queue "gdpr" (guide steps 8.1 to 8.3). gdpr.export packs the data of an
 * organization into an archive; after its last attempt the request fails, so the owner can ask
 * again. gdpr.erase erases an organization 30 days after its deletion; it is never given up: the
 * sweep hands it on again. gdpr.sweep deletes the archives of expired exports, hands on the due
 * erasures and cleans up the media library. One job at a time per worker: an export reads and an
 * erasure deletes every table of an organization. Logs carry ids and counts, never data of the
 * organization.
 */
@Processor(GDPR_QUEUE, { concurrency: 1 })
export class GdprProcessor extends WorkerHost {
  constructor(
    @Inject(GDPR_PIPELINE) private readonly pipeline: GdprPipeline,
    @InjectPinoLogger(GdprProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  process(job: Job): Promise<ExportResult | ErasureResult | SweepResult> {
    if (job.name === GDPR_EXPORT) {
      const { requestId } = this.parse(job, parseGdprJob);
      return this.run(job, { requestId }, () => this.export(job, requestId));
    }
    if (job.name === GDPR_ERASE) {
      const { requestId } = this.parse(job, parseGdprJob);
      return this.run(job, { requestId }, () => this.pipeline.eraser.execute(requestId));
    }
    if (job.name === GDPR_SWEEP) {
      this.parse(job, parseGdprSweep);
      return this.run(job, {}, () => this.sweep());
    }
    throw new UnrecoverableError(`unknown job ${job.name}`);
  }

  private async sweep(): Promise<SweepResult> {
    const expired = await this.pipeline.expire.execute();
    const scheduled = await this.pipeline.schedule.execute();
    const media = await this.pipeline.media.execute();
    return { ...expired, ...scheduled, ...media };
  }

  private async export(job: Job, requestId: string): Promise<ExportResult> {
    try {
      return await this.pipeline.exporter.execute(requestId);
    } catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await this.pipeline.requests.fail(requestId, systemClock.now(), { failure: 'INTERNAL' });
      }
      throw error;
    }
  }

  private parse<T>(job: Job, parse: (data: unknown) => T): T {
    try {
      return parse(job.data);
    } catch (error) {
      if (error instanceof ZodError) {
        this.logger.error({ jobId: job.id, job: job.name }, 'gdpr.invalid_payload');
        jobsTotal.inc({ queue: GDPR_QUEUE, status: 'invalid' });
        throw new UnrecoverableError(`invalid ${job.name} payload`);
      }
      throw error;
    }
  }

  private async run<T>(job: Job, target: Record<string, string>, work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      jobsTotal.inc({ queue: GDPR_QUEUE, status: 'completed' });
      this.logger.info({ jobId: job.id, job: job.name, ...target, result }, 'gdpr.job');
      return result;
    } catch (error) {
      jobsTotal.inc({ queue: GDPR_QUEUE, status: 'failed' });
      this.logger.warn(
        { jobId: job.id, job: job.name, ...target, attempt: job.attemptsMade + 1, err: error },
        'gdpr.job_failed',
      );
      throw error;
    }
  }
}
