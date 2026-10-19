import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { RefreshConnection, type RefreshConnectionOutcome } from '@smp/core';
import { parseTokenRefresh, TOKEN_REFRESH, TOKENS_QUEUE } from '@smp/queue';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import type { PublishPipeline } from '../infrastructure/publisher.providers';
import { JobLogContext } from '../job-log-context';
import { jobsTotal, tokenRefreshTotal } from '../metrics';
import { PUBLISH_PIPELINE } from '../worker.tokens';

/**
 * token.refresh in the role "publisher" (guide step 4.9, architecture 7.4): renews the access of
 * a connection that tick.tokens found running out, under the lock of the connection, like the
 * refresh before a post. A platform that cannot renew it leaves the connection EXPIRING; a
 * refused refresh asks for a new grant. Busy locks and platform errors are retried by BullMQ.
 * Logs carry ids, never tokens.
 */
@Processor(TOKENS_QUEUE, { concurrency: 2 })
export class TokenRefreshProcessor extends WorkerHost {
  private readonly refresh: RefreshConnection;

  constructor(
    @Inject(PUBLISH_PIPELINE) pipeline: PublishPipeline,
    @InjectPinoLogger(TokenRefreshProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
    this.refresh = new RefreshConnection({
      ...pipeline.tokenRefresh,
      logger: {
        info: (fields, message) => {
          this.logger.info(fields, message);
        },
        warn: (fields, message) => {
          this.logger.warn(fields, message);
        },
      },
    });
  }

  @JobLogContext()
  async process(job: Job): Promise<RefreshConnectionOutcome> {
    if (job.name !== TOKEN_REFRESH) {
      throw new UnrecoverableError(`unknown job ${job.name}`);
    }
    let payload;
    try {
      payload = parseTokenRefresh(job.data);
    } catch (error) {
      if (error instanceof ZodError) {
        this.logger.error({ jobId: job.id }, 'token.invalid_payload');
        jobsTotal.inc({ queue: TOKENS_QUEUE, status: 'invalid' });
        throw new UnrecoverableError('invalid token.refresh payload');
      }
      throw error;
    }
    let outcome: RefreshConnectionOutcome;
    try {
      outcome = await this.refresh.execute(payload);
    } catch (error) {
      jobsTotal.inc({ queue: TOKENS_QUEUE, status: 'failed' });
      tokenRefreshTotal.inc({ outcome: 'error' });
      this.logger.warn(
        { jobId: job.id, connectionId: payload.connectionId, attempt: job.attemptsMade + 1, err: error },
        'token.refresh_failed',
      );
      throw error;
    }
    jobsTotal.inc({ queue: TOKENS_QUEUE, status: 'completed' });
    tokenRefreshTotal.inc({ outcome });
    this.logger.info({ jobId: job.id, connectionId: payload.connectionId, outcome }, 'token.refresh');
    return outcome;
  }
}
