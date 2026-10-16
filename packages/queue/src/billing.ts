import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

import { stripeJobId } from './job-id';

// Queue "billing" (architecture 7.4), processed by the worker role "billing" from phase 7: Stripe
// webhooks after their signature was checked, and the usage reports to Stripe.

export const BILLING_QUEUE = 'billing';
export const STRIPE_WEBHOOK = 'stripe.webhook';
export const USAGE_REPORT = 'usage.report';

export const stripeWebhookSchema = z.object({
  // The id of the Stripe event; the job reads the stored event (WebhookEvent).
  eventId: z.string().regex(/^evt_[A-Za-z0-9]{1,250}$/),
});
export type StripeWebhook = z.output<typeof stripeWebhookSchema>;

export const usageReportSchema = z.object({
  organizationId: z.uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type UsageReport = z.output<typeof usageReportSchema>;

const DAY_SECONDS = 24 * 60 * 60;

export const BILLING_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: DAY_SECONDS },
  removeOnFail: { age: 7 * DAY_SECONDS },
};

export const parseStripeWebhook = (data: unknown): StripeWebhook => stripeWebhookSchema.parse(data);
export const parseUsageReport = (data: unknown): UsageReport => usageReportSchema.parse(data);

export class BillingProducer {
  constructor(private readonly queue: Queue) {}

  /** One job per Stripe event, however often Stripe sends it. */
  async stripeWebhook(job: StripeWebhook): Promise<void> {
    const payload = stripeWebhookSchema.parse(job);
    await this.queue.add(STRIPE_WEBHOOK, payload, {
      ...BILLING_JOB_OPTIONS,
      jobId: stripeJobId(payload.eventId),
    });
  }

  async usageReport(job: UsageReport): Promise<void> {
    await this.queue.add(USAGE_REPORT, usageReportSchema.parse(job), BILLING_JOB_OPTIONS);
  }
}
