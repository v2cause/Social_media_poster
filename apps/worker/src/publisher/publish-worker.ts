import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PublishVariant } from '@smp/core';
import { PUBLISH_QUEUE, publishVariantSchema } from '@smp/queue';
import { type Job, Worker } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';

import type { PublishPipeline } from '../infrastructure/publisher.providers';
import { publishDeadLettersTotal } from '../metrics';
import { PublishProcessor } from '../processors/publish.processor';
import type { WorkerEnv } from '../worker-env';
import { PUBLISH_PIPELINE, WORKER_ENV } from '../worker.tokens';
import { publishBackoff } from './publish-backoff';

// The BullMQ worker of the queue "publish" (guide step 4.8). It is built by hand instead of with
// @Processor, because concurrency, lock duration and stall check come from the environment, and
// the backoff strategy is registered with it as settings.backoffStrategy. A worker that stops
// gracefully finishes its runs; kill() stops at once, like a crashed process.

@Injectable()
export class PublishWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private worker: Worker | null = null;
  /** The signals of the running jobs. */
  private readonly running = new Set<AbortController>();

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(PUBLISH_PIPELINE) private readonly pipeline: PublishPipeline,
    @InjectPinoLogger(PublishWorker.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    const log = {
      info: (fields: Record<string, unknown>, message: string) => {
        this.logger.info(fields, message);
      },
      warn: (fields: Record<string, unknown>, message: string) => {
        this.logger.warn(fields, message);
      },
    };
    const processor = new PublishProcessor(new PublishVariant({ ...this.pipeline.deps, logger: log }), log);
    this.worker = new Worker(
      PUBLISH_QUEUE,
      async (job, token) => {
        const controller = new AbortController();
        this.running.add(controller);
        try {
          return await processor.process(job, token, controller.signal);
        } finally {
          this.running.delete(controller);
        }
      },
      {
        connection: this.pipeline.workerConnection,
        concurrency: this.env.PUBLISH_CONCURRENCY,
        lockDuration: this.env.PUBLISH_LOCK_MS,
        // A stopped worker's job goes back to the queue once; a second stall fails it, and the
        // sweeper starts it again from the database.
        stalledInterval: this.env.PUBLISH_LOCK_MS,
        maxStalledCount: 1,
        settings: { backoffStrategy: publishBackoff },
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.warn({ jobId: job?.id, attempt: job?.attemptsMade, err: error }, 'publish.job_failed');
      // BullMQ sets finishedOn only when no attempt follows.
      if (job?.finishedOn) {
        void this.deadLetter(job, error);
      }
    });
    this.worker.on('error', (error) => {
      this.logger.error({ err: error }, 'publish.worker_error');
    });
  }

  /** Keeps a copy of a job that failed for good (architecture 7.1); its variant has its status. */
  private async deadLetter(job: Job, error: Error): Promise<void> {
    publishDeadLettersTotal.inc();
    const payload = publishVariantSchema.safeParse(job.data);
    if (!payload.success) {
      return;
    }
    try {
      await this.pipeline.deadLetters.add({
        ...payload.data,
        failedReason: error.message.slice(0, 1_000),
        attemptsMade: job.attemptsMade,
        failedAt: new Date(job.finishedOn ?? Date.now()).toISOString(),
      });
    } catch (failure) {
      this.logger.error({ jobId: job.id, err: failure }, 'publish.dead_letter_failed');
    }
  }

  /** Before the connections close: no new jobs, and the running ones finish. */
  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  /**
   * Stops at once, like a crashed process: the running jobs stay active until their lock runs
   * out, and their runs write nothing more. For the chaos test of guide step 4.8.
   */
  async kill(): Promise<void> {
    await this.worker?.close(true);
    for (const run of this.running) {
      run.abort(new Error('The worker was stopped.'));
    }
  }
}
