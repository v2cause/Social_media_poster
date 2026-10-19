import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import {
  isTick,
  SCHEDULER_QUEUE,
  TICK_JOB_OPTIONS,
  TICK_SCHEDULES,
  TICKS,
  type Tick,
  type TickSchedule,
} from '@smp/queue';
import { type Job, type Queue, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';

import { JobLogContext } from '../job-log-context';
import { jobsTotal, tickLagSeconds, tickLastSuccess } from '../metrics';
import type { WorkerEnv } from '../worker-env';
import { TICK_HANDLERS, WORKER_ENV } from '../worker.tokens';

// The ticks of the role "scheduler" (architecture 7.4). Every tick with a handler becomes a job
// scheduler named like the tick; all replicas upsert the same definitions, so each tick runs on
// one worker at a time, and a tick without a handler loses its scheduler. The steps of the guide
// add their ticks as they come (4.7 publish and sweeper, 4.9 tokens, phase 5 analytics, 6.5 the
// canary of the X browser).

/** What a tick did, for the log; an empty record means there was nothing to do. */
export type TickResult = Readonly<Record<string, unknown>>;
export type TickHandlers = Partial<Record<Tick, () => Promise<TickResult>>>;

/** The placeholder tick of phase 0, removed from Redis on start. */
const LEGACY_SCHEDULER_ID = 'scheduler-tick';

const isIdle = (result: TickResult): boolean =>
  Object.values(result).every((value) => value === 0 || value === null || value === undefined);

@Processor(SCHEDULER_QUEUE, { concurrency: 4 })
export class SchedulerProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(SCHEDULER_QUEUE) private readonly queue: Queue,
    @Inject(TICK_HANDLERS) private readonly handlers: TickHandlers,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @InjectPinoLogger(SchedulerProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.removeJobScheduler(LEGACY_SCHEDULER_ID);
    for (const tick of TICKS) {
      if (this.handlers[tick]) {
        await this.queue.upsertJobScheduler(tick, this.scheduleOf(tick), {
          name: tick,
          opts: TICK_JOB_OPTIONS,
        });
      } else {
        // A tick the configuration no longer asks for, like the canary without its test account.
        await this.queue.removeJobScheduler(tick);
      }
    }
  }

  /** SCHEDULER_TICK_MS sets the pace of tick.publish, for example faster in time-lapse tests. */
  private scheduleOf(tick: Tick): TickSchedule {
    return tick === 'tick.publish' ? { every: this.env.SCHEDULER_TICK_MS } : TICK_SCHEDULES[tick];
  }

  @JobLogContext()
  async process(job: Job): Promise<TickResult> {
    const handler = isTick(job.name) ? this.handlers[job.name] : undefined;
    if (!handler) {
      throw new UnrecoverableError(`no handler for ${job.name}`);
    }
    const started = performance.now();
    // How late the run started against the time the job scheduler gave it.
    tickLagSeconds.set(
      { tick: job.name },
      Math.max(0, (job.processedOn ?? Date.now()) - (job.timestamp + job.delay)) / 1_000,
    );
    try {
      const result = await handler();
      tickLastSuccess.set({ tick: job.name }, Date.now() / 1_000);
      const fields = { tick: job.name, durationMs: Math.round(performance.now() - started), ...result };
      if (isIdle(result)) {
        this.logger.debug(fields, 'scheduler.tick');
      } else {
        this.logger.info(fields, 'scheduler.tick');
      }
      jobsTotal.inc({ queue: SCHEDULER_QUEUE, status: 'completed' });
      return result;
    } catch (error) {
      jobsTotal.inc({ queue: SCHEDULER_QUEUE, status: 'failed' });
      this.logger.error({ tick: job.name, err: error }, 'scheduler.tick_failed');
      throw error;
    }
  }
}
