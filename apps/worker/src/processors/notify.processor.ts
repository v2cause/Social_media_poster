import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { DeliverNotification, DeliveryReport, MailPort } from '@smp/core';
import { deliverEmail } from '@smp/emails';
import { NOTIFICATIONS_QUEUE, NOTIFY_DISPATCH, parseNotifyDispatch, type NotifyDispatch } from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import { jobsTotal } from '../metrics';
import { DELIVER_NOTIFICATION, MAIL_PORT } from '../worker.tokens';

/**
 * Delivers notifications (guide steps 1.8 and 4.9). An email is rendered in the recipient's
 * language and sent over SMTP. An event of the outbox goes to its recipients: in the app, and
 * by email as one job per recipient. Failures are retried by BullMQ; payloads that do not
 * validate fail at once. Logs carry the job id, never an address.
 */
@Processor(NOTIFICATIONS_QUEUE)
export class NotifyProcessor extends WorkerHost {
  constructor(
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(DELIVER_NOTIFICATION) private readonly deliver: DeliverNotification,
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
    try {
      if (payload.channel === 'event') {
        const report = await this.deliver.execute(payload);
        jobsTotal.inc({ queue: NOTIFICATIONS_QUEUE, status: 'completed' });
        this.logger.info({ jobId: job.id, type: payload.request.type, ...report }, 'notify.delivered');
        return report;
      }
      await deliverEmail(this.mail, payload.to, payload.email);
    } catch (error) {
      jobsTotal.inc({ queue: NOTIFICATIONS_QUEUE, status: 'failed' });
      this.logger.warn({ jobId: job.id, attempt: job.attemptsMade + 1, err: error }, 'notify.send_failed');
      throw error;
    }
    jobsTotal.inc({ queue: NOTIFICATIONS_QUEUE, status: 'completed' });
    this.logger.info({ jobId: job.id, template: payload.email.template }, 'notify.sent');
    return undefined;
  }
}
