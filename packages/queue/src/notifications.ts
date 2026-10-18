import { PUBLISH_FAILURE_CODES, type NotificationRequest, type SecretSealer } from '@smp/core';
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
// token is stored (ADR 0012). Both are sealed with the token keyring, so Redis, its AOF and its
// backups hold neither address nor link in the clear (guide step 8.4); the role "notify" opens
// them right before it sends. A job leaves Redis right after delivery, a failed one after a day.

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

/** What an email job seals: the address and the email. */
const sealedEmailSchema = z.object({
  to: z.email().max(254),
  email: emailTemplateSchema,
});
export type SealedEmail = z.output<typeof sealedEmailSchema>;

/** The AAD of a sealed email, so that no other envelope of the keyring passes for one. */
const EMAIL_AAD = 'notify.email';
/** An envelope of the longest email with room to spare, in base64. */
const MAX_SEALED_LENGTH = 64 * 1024;

const emailDispatchSchema = z.object({
  channel: z.literal('email'),
  /** The SealedEmail, sealed with the token keyring, as base64. */
  sealed: z.base64().max(MAX_SEALED_LENGTH),
});
export type EmailDispatch = z.output<typeof emailDispatchSchema>;

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

/**
 * Opens the email of a job and validates it again. Throws when the envelope is damaged or its
 * key is not configured, and a ZodError for content that is no email.
 */
export async function openNotifyEmail(
  sealer: Pick<SecretSealer, 'open'>,
  payload: EmailDispatch,
): Promise<SealedEmail> {
  const opened = await sealer.open(Buffer.from(payload.sealed, 'base64'), EMAIL_AAD);
  return sealedEmailSchema.parse(JSON.parse(opened));
}

/** Typed producer of the notifications queue for the API and the worker. */
export class NotificationProducer {
  constructor(
    private readonly queue: Queue,
    private readonly sealer: Pick<SecretSealer, 'seal'>,
  ) {}

  async dispatchEmail(to: string, email: EmailTemplateInput): Promise<void> {
    await this.queue.add(NOTIFY_DISPATCH, await this.sealedEmail(to, email), NOTIFY_JOB_OPTIONS);
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
    await this.queue.add(NOTIFY_DISPATCH, await this.sealedEmail(to, email), {
      ...NOTIFY_EVENT_JOB_OPTIONS,
      jobId: notifyEmailJobId(eventId, userId),
    });
  }

  /** Validates the email first: what is sealed is no longer checked before it is opened. */
  private async sealedEmail(to: string, email: EmailTemplateInput): Promise<EmailDispatch> {
    const content = sealedEmailSchema.parse({ to, email });
    const sealed = await this.sealer.seal(JSON.stringify(content), EMAIL_AAD);
    return emailDispatchSchema.parse({ channel: 'email', sealed: Buffer.from(sealed).toString('base64') });
  }
}
