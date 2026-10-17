import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import {
  CollectAccountMetrics,
  CollectPostMetrics,
  type AdapterLogger,
  type CollectAccountMetricsResult,
  type CollectPostMetricsResult,
} from '@smp/core';
import {
  ANALYTICS_QUEUE,
  METRICS_ACCOUNT,
  METRICS_POST,
  parseMetricsAccount,
  parseMetricsPost,
} from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import type { AnalyticsPipeline } from '../infrastructure/analytics.providers';
import { jobsTotal } from '../metrics';
import { ANALYTICS_PIPELINE } from '../worker.tokens';

/** Analytics jobs at once per worker process; each one waits for the platform most of the time. */
export const ANALYTICS_CONCURRENCY = 4;

/**
 * The jobs of the queue "analytics" (guide step 5.2, architecture 8). metrics.post polls the due
 * posts of an account, metrics.account the numbers of an account for a day. A failure of the
 * platform postpones the polls instead of failing the job; other errors are retried by BullMQ.
 * Logs carry ids, never tokens.
 */
@Processor(ANALYTICS_QUEUE, { concurrency: ANALYTICS_CONCURRENCY })
export class AnalyticsProcessor extends WorkerHost {
  private readonly postMetrics: CollectPostMetrics;
  private readonly accountMetrics: CollectAccountMetrics;

  constructor(
    @Inject(ANALYTICS_PIPELINE) pipeline: AnalyticsPipeline,
    @InjectPinoLogger(AnalyticsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
    const adapterLogger: AdapterLogger = {
      info: (fields, message) => {
        this.logger.info(fields, message);
      },
      warn: (fields, message) => {
        this.logger.warn(fields, message);
      },
    };
    this.postMetrics = new CollectPostMetrics({ ...pipeline.deps, logger: adapterLogger });
    this.accountMetrics = new CollectAccountMetrics({ ...pipeline.deps, logger: adapterLogger });
  }

  process(job: Job): Promise<CollectPostMetricsResult | CollectAccountMetricsResult> {
    const signal = new AbortController().signal;
    if (job.name === METRICS_POST) {
      const payload = this.parse(job, parseMetricsPost);
      return this.run(job, payload.accountId, () => this.postMetrics.execute({ ...payload, signal }));
    }
    if (job.name === METRICS_ACCOUNT) {
      const payload = this.parse(job, parseMetricsAccount);
      return this.run(job, payload.accountId, () => this.accountMetrics.execute({ ...payload, signal }));
    }
    throw new UnrecoverableError(`unknown job ${job.name}`);
  }

  private parse<T>(job: Job, parse: (data: unknown) => T): T {
    try {
      return parse(job.data);
    } catch (error) {
      if (error instanceof ZodError) {
        this.logger.error({ jobId: job.id, job: job.name }, 'analytics.invalid_payload');
        jobsTotal.inc({ queue: ANALYTICS_QUEUE, status: 'invalid' });
        throw new UnrecoverableError(`invalid ${job.name} payload`);
      }
      throw error;
    }
  }

  private async run<T>(job: Job, accountId: string, work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      jobsTotal.inc({ queue: ANALYTICS_QUEUE, status: 'completed' });
      this.logger.info({ jobId: job.id, job: job.name, accountId, result }, 'analytics.job');
      return result;
    } catch (error) {
      jobsTotal.inc({ queue: ANALYTICS_QUEUE, status: 'failed' });
      this.logger.warn(
        { jobId: job.id, job: job.name, accountId, attempt: job.attemptsMade + 1, err: error },
        'analytics.job_failed',
      );
      throw error;
    }
  }
}
