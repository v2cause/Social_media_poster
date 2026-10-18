import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { systemClock, type ExportResult } from '@smp/core';
import { GDPR_EXPORT, GDPR_QUEUE, GDPR_SWEEP, parseGdprJob, parseGdprSweep } from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import type { GdprPipeline } from '../infrastructure/gdpr.providers';
import { jobsTotal } from '../metrics';
import { GDPR_PIPELINE } from '../worker.tokens';

/**
 * The jobs of the queue "gdpr" (guide step 8.1). gdpr.export packs the data of an organization
 * into an archive; after its last attempt the request fails, so the owner can ask again.
 * gdpr.sweep deletes the archives of expired exports. One job at a time per worker: an export
 * reads every table of an organization. Logs carry ids and counts, never data of the export.
 */
@Processor(GDPR_QUEUE, { concurrency: 1 })
export class GdprProcessor extends WorkerHost {
  constructor(
    @Inject(GDPR_PIPELINE) private readonly pipeline: GdprPipeline,
    @InjectPinoLogger(GdprProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  process(job: Job): Promise<ExportResult | { exportsExpired: number; exportsTimedOut: number }> {
    if (job.name === GDPR_EXPORT) {
      const { requestId } = this.parse(job, parseGdprJob);
      return this.run(job, { requestId }, () => this.export(job, requestId));
    }
    if (job.name === GDPR_SWEEP) {
      this.parse(job, parseGdprSweep);
      return this.run(job, {}, () => this.pipeline.expire.execute());
    }
    throw new UnrecoverableError(`unknown job ${job.name}`);
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
