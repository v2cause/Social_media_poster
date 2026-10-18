import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { DeliverNotification, DeliveryReport, MailPort, SecretSealer } from '@smp/core';
import { deliverEmail } from '@smp/emails';
import {
  NOTIFICATIONS_QUEUE,
  NOTIFY_DISPATCH,
  openNotifyEmail,
  parseNotifyDispatch,
  type NotifyDispatch,
  type SealedEmail,
} from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import { jobsTotal } from '../metrics';
import { DELIVER_NOTIFICATION, EMAIL_SEALER, MAIL_PORT } from '../worker.tokens';

/**
 * Delivers notifications (guide steps 1.8 and 4.9). An email is opened with the token keyring
 * (guide step 8.4), rendered in the recipient's language and sent over SMTP. An event of the
 * outbox goes to its recipients: in the app, and by email as one job per recipient. Failures are
 * retried by BullMQ; payloads that do not validate or open fail at once. Logs carry the job id,
 * never an address.
 */
@Processor(NOTIFICATIONS_QUEUE)
export class NotifyProcessor extends WorkerHost {
  constructor(
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(DELIVER_NOTIFICATION) private readonly deliver: DeliverNotification,
    @Inject(EMAIL_SEALER) private readonly sealer: Pick<SecretSealer, 'open'>,
    @InjectPinoLogger(NotifyProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<DeliveryReport | undefined> {
    if (job.name !== NOTIFY_DISPATCH) {
      throw new UnrecoverableError(`unknown job ${job.name}`);
    }
    let payload: NotifyDispatch;
    try {
      payload = parseNotifyDispatch(job.data);
    } catch (error) {
      if (error instanceof ZodError) {
        this.logger.error({ jobId: job.id }, 'notify.invalid_payload');
        jobsTotal.inc({ queue: NOTIFICATIONS_QUEUE, status: 'invalid' });
        throw new UnrecoverableError('invalid notify.dispatch payload');
      }
      throw error;
    }
    if (payload.channel === 'event') {
      return this.deliverEvent(job, payload);
    }
    const email = await this.open(job, payload);
    try {
      await deliverEmail(this.mail, email.to, email.email);
    } catch (error) {
      this.failed(job, error);
      throw error;
    }
    jobsTotal.inc({ queue: NOTIFICATIONS_QUEUE, status: 'completed' });
    this.logger.info({ jobId: job.id, template: email.email.template }, 'notify.sent');
    return undefined;
  }

  private async deliverEvent(
    job: Job,
    payload: Extract<NotifyDispatch, { channel: 'event' }>,
  ): Promise<DeliveryReport> {
    try {
      const report = await this.deliver.execute(payload);
      jobsTotal.inc({ queue: NOTIFICATIONS_QUEUE, status: 'completed' });
      this.logger.info({ jobId: job.id, type: payload.request.type, ...report }, 'notify.delivered');
      return report;
    } catch (error) {
      this.failed(job, error);
      throw error;
    }
  }

  /** A damaged envelope, one of another key or content that is no email: no retry helps. */
  private async open(job: Job, payload: Extract<NotifyDispatch, { channel: 'email' }>): Promise<SealedEmail> {
    try {
      return await openNotifyEmail(this.sealer, payload);
    } catch {
      this.logger.error({ jobId: job.id }, 'notify.unreadable_email');
      jobsTotal.inc({ queue: NOTIFICATIONS_QUEUE, status: 'invalid' });
      throw new UnrecoverableError('unreadable notify.dispatch email');
    }
  }

  private failed(job: Job, error: unknown): void {
    jobsTotal.inc({ queue: NOTIFICATIONS_QUEUE, status: 'failed' });
    this.logger.warn({ jobId: job.id, attempt: job.attemptsMade + 1, err: error }, 'notify.send_failed');
  }
}
