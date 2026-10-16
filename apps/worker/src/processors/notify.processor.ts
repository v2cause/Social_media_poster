import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { MailPort } from '@smp/core';
import { deliverEmail } from '@smp/emails';
import { NOTIFICATIONS_QUEUE, NOTIFY_DISPATCH, parseNotifyDispatch } from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import { jobsTotal } from '../metrics';
import { MAIL_PORT } from '../worker.tokens';

/**
 * Delivers notifications (guide step 1.8). For now every notification is an email: render it in
 * the recipient's language and send it over SMTP. Failed sends are retried by BullMQ; payloads
 * that do not validate fail at once. Logs carry the job id, never the address.
 */
@Processor(NOTIFICATIONS_QUEUE)
export class NotifyProcessor extends WorkerHost {
  constructor(
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @InjectPinoLogger(NotifyProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== NOTIFY_DISPATCH) {
      throw new UnrecoverableError(`unknown job ${job.name}`);
    }
    let payload;
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
      await deliverEmail(this.mail, payload.to, payload.email);
    } catch (error) {
      jobsTotal.inc({ queue: NOTIFICATIONS_QUEUE, status: 'failed' });
      this.logger.warn({ jobId: job.id, attempt: job.attemptsMade + 1, err: error }, 'notify.send_failed');
      throw error;
    }
    jobsTotal.inc({ queue: NOTIFICATIONS_QUEUE, status: 'completed' });
    this.logger.info({ jobId: job.id, template: payload.email.template }, 'notify.sent');
  }
}
