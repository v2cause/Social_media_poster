import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { ProcessStripeWebhookResult } from '@smp/core';
import { BILLING_QUEUE, parseStripeWebhook, STRIPE_WEBHOOK } from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import type { BillingPipeline } from '../infrastructure/billing.providers';
import { jobsTotal } from '../metrics';
import { BILLING_PIPELINE } from '../worker.tokens';

/**
 * The jobs of the queue "billing" (guide step 7.2). stripe.webhook reads the subscription of a
 * recorded Stripe event from Stripe and takes plan and status over. Failures are retried by
 * BullMQ; payloads that do not validate fail at once. Logs carry the ids of Stripe, never a key.
 */
@Processor(BILLING_QUEUE)
export class BillingProcessor extends WorkerHost {
  constructor(
    @Inject(BILLING_PIPELINE) private readonly pipeline: BillingPipeline,
    @InjectPinoLogger(BillingProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<ProcessStripeWebhookResult> {
    if (job.name !== STRIPE_WEBHOOK) {
      throw new UnrecoverableError(`unknown job ${job.name}`);
    }
    let eventId: string;
    try {
      eventId = parseStripeWebhook(job.data).eventId;
    } catch (error) {
      if (error instanceof ZodError) {
        this.logger.error({ jobId: job.id, job: job.name }, 'billing.invalid_payload');
        jobsTotal.inc({ queue: BILLING_QUEUE, status: 'invalid' });
        throw new UnrecoverableError(`invalid ${job.name} payload`);
      }
      throw error;
    }
    try {
      const result = await this.pipeline.webhooks.execute(eventId);
      jobsTotal.inc({ queue: BILLING_QUEUE, status: 'completed' });
      this.logger.info({ jobId: job.id, eventId, result }, 'billing.webhook');
      return result;
    } catch (error) {
      jobsTotal.inc({ queue: BILLING_QUEUE, status: 'failed' });
      this.logger.warn(
        { jobId: job.id, eventId, attempt: job.attemptsMade + 1, err: error },
        'billing.webhook_failed',
      );
      throw error;
    }
  }
}
