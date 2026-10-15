import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';

import type { WorkerEnv } from '../worker-env';
import { WORKER_ENV } from '../worker.tokens';
import { jobsTotal } from '../metrics';

export const SCHEDULER_QUEUE = 'scheduler';
export const SCHEDULER_TICK_ID = 'scheduler-tick';

/**
 * Registers the recurring tick and logs every tick. It does no business work and exists to
 * prove the scheduler path end to end. Each replica upserts the same scheduler ID, so there is
 * exactly one recurring definition no matter how many workers run.
 */
@Processor(SCHEDULER_QUEUE)
export class NoopProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(SCHEDULER_QUEUE) private readonly queue: Queue,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @InjectPinoLogger(NoopProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_TICK_ID,
      { every: this.env.SCHEDULER_TICK_MS },
      { name: 'tick' },
    );
  }

  process(job: Job): Promise<void> {
    this.logger.info({ jobId: job.id, jobName: job.name, queue: SCHEDULER_QUEUE }, 'scheduler.tick');
    jobsTotal.inc({ queue: SCHEDULER_QUEUE, status: 'completed' });
    return Promise.resolve();
  }
}
