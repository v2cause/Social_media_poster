import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

import { publishJobId } from './job-id';

// Queue "publish", job "publish.variant" (architecture 7 and 7.4), processed by the worker role
// "publisher". The payload names the variant and the schedule version it belongs to; the job
// reads everything else from the database and ends without action when the variant moved on.

export const PUBLISH_QUEUE = 'publish';
export const PUBLISH_VARIANT = 'publish.variant';

/** schedule: the tick; now: "Jetzt posten"; retry: after FAILED or NEEDS_ATTENTION; sweep: the sweeper. */
export const PUBLISH_TRIGGERS = ['schedule', 'now', 'retry', 'sweep'] as const;
export type PublishTrigger = (typeof PUBLISH_TRIGGERS)[number];

// W3C trace context, so the publish span continues the trace of the request that planned it.
const TRACEPARENT = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;

export const publishVariantSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  variantId: z.uuid(),
  scheduleVersion: z.number().int().nonnegative(),
  trigger: z.enum(PUBLISH_TRIGGERS),
  traceparent: z.string().regex(TRACEPARENT).optional(),
});
export type PublishVariant = z.output<typeof publishVariantSchema>;

/** The backoff strategy the publisher registers as settings.backoffStrategy (guide step 4.8). */
export const PUBLISH_BACKOFF = 'publish';
export const PUBLISH_MAX_ATTEMPTS = 6;

const DAY_SECONDS = 24 * 60 * 60;

export const PUBLISH_JOB_OPTIONS: JobsOptions = {
  attempts: PUBLISH_MAX_ATTEMPTS,
  backoff: { type: PUBLISH_BACKOFF },
  // Kept a day, so adding the same id again stays a no-op.
  removeOnComplete: { age: DAY_SECONDS },
  // Kept for the sweeper, which restarts a failed job with job.retry() (guide step 4.7).
  removeOnFail: { age: 7 * DAY_SECONDS },
};

export const parsePublishVariant = (data: unknown): PublishVariant => publishVariantSchema.parse(data);

export class PublishProducer {
  constructor(private readonly queue: Queue) {}

  /** Adds the job of a schedule version; a second add with the same version changes nothing. */
  async publish(job: PublishVariant, options: { delayMs?: number } = {}): Promise<void> {
    const payload = publishVariantSchema.parse(job);
    await this.queue.add(PUBLISH_VARIANT, payload, {
      ...PUBLISH_JOB_OPTIONS,
      jobId: publishJobId(payload.variantId, payload.scheduleVersion),
      delay: Math.max(0, Math.round(options.delayMs ?? 0)),
    });
  }
}
