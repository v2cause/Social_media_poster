import type { PublishJobOutcome, PublishVariant } from '@smp/core';
import { parsePublishVariant, PUBLISH_QUEUE, type PublishVariant as PublishVariantJob } from '@smp/queue';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { ZodError } from 'zod';

import { JobLogContext } from '../job-log-context';
import { jobsTotal } from '../metrics';
import { PublishRetryError } from '../publisher/publish-backoff';

// publish.variant (guide step 4.8, architecture 7 and 7.1): runs the job of a schedule version
// and puts its outcome into the terms of BullMQ.
// - A rate limit, or the live lease of another run, moves the job to later without using up an
//   attempt: job.moveToDelayed() and then DelayedError.
// - An error that may pass is thrown, so the backoff strategy of the worker applies.
// - A final failure ends the job: UnrecoverableError with the code.
// - Every other outcome completes the job; the variant already has its status.
// Logs carry ids and codes, never the content of a post.

export interface PublishLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export class PublishProcessor {
  constructor(
    private readonly publishVariant: Pick<PublishVariant, 'execute'>,
    private readonly log: PublishLog,
    private readonly now: () => number = Date.now,
  ) {}

  @JobLogContext()
  async process(job: Job, token: string | undefined, signal: AbortSignal): Promise<string> {
    const payload = this.parse(job);
    if (!token) {
      throw new UnrecoverableError('a publish job needs the lock token of its worker');
    }
    const attempt = job.attemptsMade + 1;
    const outcome = await this.publishVariant.execute({
      organizationId: payload.organizationId,
      workspaceId: payload.workspaceId,
      variantId: payload.variantId,
      scheduleVersion: payload.scheduleVersion,
      trigger: payload.trigger,
      lastAttempt: attempt >= (job.opts.attempts ?? 1),
      // The lock token is unique per run of a job, so a stalled run never mistakes the lease of
      // its successor for its own.
      owner: token,
      signal,
    });
    jobsTotal.inc({ queue: PUBLISH_QUEUE, status: outcome.kind });
    this.log.info({ jobId: job.id, variantId: payload.variantId, attempt, outcome }, 'publish.outcome');
    return this.settle(job, token, outcome);
  }

  private async settle(job: Job, token: string, outcome: PublishJobOutcome): Promise<string> {
    switch (outcome.kind) {
      case 'busy':
        return this.later(job, token, outcome.retryInMs);
      case 'retry':
        if (!outcome.countsAsAttempt) {
          return this.later(job, token, outcome.retryAfterMs ?? 0);
        }
        throw new PublishRetryError(outcome.code, outcome.retryAfterMs);
      case 'failed':
        throw new UnrecoverableError(outcome.code);
      case 'skipped':
        return `skipped:${outcome.reason}`;
      case 'published':
        return outcome.dryRun ? 'dry_run' : outcome.reconciled ? 'reconciled' : 'published';
      case 'needs_attention':
        return `needs_attention:${outcome.code}`;
    }
  }

  /** Moves the job to later without using up an attempt. */
  private async later(job: Job, token: string, delayMs: number): Promise<never> {
    await job.moveToDelayed(this.now() + delayMs, token);
    throw new DelayedError();
  }

  private parse(job: Job): PublishVariantJob {
    try {
      return parsePublishVariant(job.data);
    } catch (error) {
      if (error instanceof ZodError) {
        this.log.warn({ jobId: job.id, job: job.name }, 'publish.invalid_payload');
        jobsTotal.inc({ queue: PUBLISH_QUEUE, status: 'invalid' });
        throw new UnrecoverableError(`invalid ${job.name} payload`);
      }
      throw error;
    }
  }
}
