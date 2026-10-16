import { PUBLISH_FAILURE_CODES, type NotificationRequest } from '@smp/core';
import { emailTemplateSchema, type EmailTemplateInput } from '@smp/emails';
import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

import { notifyEmailJobId, notifyJobId } from './job-id';

// Queue "notifications", job "notify.dispatch" (architecture 7.4), processed by the worker role
// "notify". The payload is validated when it is added and again when it is processed. A job is
// either an email to one address or an event of the outbox (guide step 4.9, ADR 0025): for an
// event the role reads what it is about, adds the in-app notifications and queues one email per
// recipient.
//
// Exception to "payloads hold only ids": an email carries its address and text. One with a link
// (verification, password reset, invitation) carries its link, because only the hash of the
// token is stored, so it leaves Redis right after delivery (ADR 0012). Failed jobs stay one day.

export const NOTIFICATIONS_QUEUE = 'notifications';
export const NOTIFY_DISPATCH = 'notify.dispatch';

/** What an outbox event asks to tell; the NotificationRequest of the core. */
export const notificationRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('token-expiring'),
    connectionId: z.uuid(),
    daysLeft: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal('reauth-required'),
    connectionId: z.uuid(),
    reason: z.string().min(1).max(64),
    scheduledVariants: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('publish-failed'),
    variantId: z.uuid(),
    failureCode: z.enum(PUBLISH_FAILURE_CODES),
  }),
  z.object({
    type: z.literal('needs-attention'),
    variantId: z.uuid(),
    failureCode: z.enum(PUBLISH_FAILURE_CODES),
  }),
]) satisfies z.ZodType<NotificationRequest>;

const emailDispatchSchema = z.object({
  channel: z.literal('email'),
  to: z.email().max(254),
  email: emailTemplateSchema,
});

const eventDispatchSchema = z.object({
  channel: z.literal('event'),
  /** The id of the outbox event. */
  eventId: z.uuid(),
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  request: notificationRequestSchema,
});

export const notifyDispatchSchema = z.discriminatedUnion('channel', [
  emailDispatchSchema,
  eventDispatchSchema,
]);
export type NotifyDispatch = z.output<typeof notifyDispatchSchema>;
/** An outbox event for the role "notify". */
export type NotifyEvent = Omit<z.output<typeof eventDispatchSchema>, 'channel'>;

const DAY_SECONDS = 24 * 60 * 60;

/** Retries with backoff (about 10 s, 20 s, 40 s, ...), then the job stays one day for analysis. */
export const NOTIFY_JOB_OPTIONS: JobsOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: DAY_SECONDS },
};

/**
 * An event and its emails stay one day after they ran, so their job ids keep working: a second
 * dispatch of the event (after a failed commit of the relay) or another run of its job sends no
 * email twice. These emails carry no token.
 */
export const NOTIFY_EVENT_JOB_OPTIONS: JobsOptions = {
  ...NOTIFY_JOB_OPTIONS,
  removeOnComplete: { age: DAY_SECONDS },
};

/** Validates a job payload. Throws a ZodError for anything else. */
export const parseNotifyDispatch = (data: unknown): NotifyDispatch => notifyDispatchSchema.parse(data);

/** Typed producer of the notifications queue for the API and the worker. */
export class NotificationProducer {
  constructor(private readonly queue: Queue) {}

  async dispatchEmail(to: string, email: EmailTemplateInput): Promise<void> {
    const payload = emailDispatchSchema.parse({ channel: 'email', to, email });
    await this.queue.add(NOTIFY_DISPATCH, payload, NOTIFY_JOB_OPTIONS);
  }

  /** One job per outbox event, ntf.{eventId}. */
  async dispatchEvent(event: NotifyEvent): Promise<void> {
    const payload = eventDispatchSchema.parse({ channel: 'event', ...event });
    await this.queue.add(NOTIFY_DISPATCH, payload, {
      ...NOTIFY_EVENT_JOB_OPTIONS,
      jobId: notifyJobId(payload.eventId),
    });
  }

  /** The email of an outbox event to one recipient, once: ntf.{eventId}.{userId}. */
  async dispatchEventEmail(
    eventId: string,
    userId: string,
    to: string,
    email: EmailTemplateInput,
  ): Promise<void> {
    const payload = emailDispatchSchema.parse({ channel: 'email', to, email });
    await this.queue.add(NOTIFY_DISPATCH, payload, {
      ...NOTIFY_EVENT_JOB_OPTIONS,
      jobId: notifyEmailJobId(eventId, userId),
    });
  }
}
