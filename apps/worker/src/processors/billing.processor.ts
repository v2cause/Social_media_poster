import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { ProcessStripeWebhookResult, UsageReportResult } from '@smp/core';
import {
  BILLING_QUEUE,
  parseStripeWebhook,
  parseUsageReport,
  STRIPE_WEBHOOK,
  USAGE_REPORT,
} from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import type { BillingPipeline } from '../infrastructure/billing.providers';
import { JobLogContext } from '../job-log-context';
import { jobsTotal } from '../metrics';
import { BILLING_PIPELINE } from '../worker.tokens';

/**
 * The jobs of the queue "billing" (guide steps 7.2 and 7.3). stripe.webhook reads the
 * subscription of a recorded Stripe event from Stripe and takes plan and status over;
 * usage.report sends the usage of an organization from before a midnight to the meters. Failures
 * are retried by BullMQ; payloads that do not validate fail at once. Logs carry ids, never a key.
 */
@Processor(BILLING_QUEUE)
export class BillingProcessor extends WorkerHost {
  constructor(
    @Inject(BILLING_PIPELINE) private readonly pipeline: BillingPipeline,
    @InjectPinoLogger(BillingProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  @JobLogContext()
  process(job: Job): Promise<ProcessStripeWebhookResult | UsageReportResult> {
    if (job.name === STRIPE_WEBHOOK) {
      const { eventId } = this.parse(job, parseStripeWebhook);
      return this.run(job, { eventId }, () => this.pipeline.webhooks.execute(eventId));
    }
    if (job.name === USAGE_REPORT) {
      const { organizationId, until } = this.parse(job, parseUsageReport);
      return this.run(job, { organizationId, until }, () =>
        this.pipeline.usage.execute({ organizationId, until: new Date(`${until}T00:00:00Z`) }),
      );
    }
    throw new UnrecoverableError(`unknown job ${job.name}`);
  }

  private parse<T>(job: Job, parse: (data: unknown) => T): T {
    try {
      return parse(job.data);
    } catch (error) {
      if (error instanceof ZodError) {
        this.logger.error({ jobId: job.id, job: job.name }, 'billing.invalid_payload');
        jobsTotal.inc({ queue: BILLING_QUEUE, status: 'invalid' });
        throw new UnrecoverableError(`invalid ${job.name} payload`);
      }
      throw error;
    }
  }

  private async run<T>(job: Job, target: Record<string, string>, work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      jobsTotal.inc({ queue: BILLING_QUEUE, status: 'completed' });
      this.logger.info({ jobId: job.id, job: job.name, ...target, result }, 'billing.job');
      return result;
    } catch (error) {
      jobsTotal.inc({ queue: BILLING_QUEUE, status: 'failed' });
      this.logger.warn(
        { jobId: job.id, job: job.name, ...target, attempt: job.attemptsMade + 1, err: error },
        'billing.job_failed',
      );
      throw error;
    }
  }
}
