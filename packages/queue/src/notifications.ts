import { emailTemplateSchema, type EmailTemplateInput } from '@smp/emails';
import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

// Queue "notifications", job "notify.dispatch" (architecture 7.4), processed by the worker role
// "notify". The payload is validated when it is added and again when it is processed.
//
// Exception to "payloads hold only ids": an email with a link (verification, password reset,
// invitation) carries its link, because only the hash of the token is stored. Jobs therefore
// leave Redis right after delivery and failed ones after one day (ADR 0012).

export const NOTIFICATIONS_QUEUE = 'notifications';
export const NOTIFY_DISPATCH = 'notify.dispatch';

export const notifyDispatchSchema = z.object({
  channel: z.literal('email'),
  to: z.email().max(254),
  email: emailTemplateSchema,
});
export type NotifyDispatch = z.output<typeof notifyDispatchSchema>;

const DAY_SECONDS = 24 * 60 * 60;

/** Retries with backoff (about 10 s, 20 s, 40 s, ...), then the job stays one day for analysis. */
export const NOTIFY_JOB_OPTIONS: JobsOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: DAY_SECONDS },
};

/** Validates a job payload. Throws a ZodError for anything else. */
export const parseNotifyDispatch = (data: unknown): NotifyDispatch => notifyDispatchSchema.parse(data);

/** Typed producer of the notifications queue for the API. */
export class NotificationProducer {
  constructor(private readonly queue: Queue) {}

  async dispatchEmail(to: string, email: EmailTemplateInput): Promise<void> {
    const payload = notifyDispatchSchema.parse({ channel: 'email', to, email });
    await this.queue.add(NOTIFY_DISPATCH, payload, NOTIFY_JOB_OPTIONS);
  }
}
