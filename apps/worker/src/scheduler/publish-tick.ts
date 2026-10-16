import type { QueuedVariant, MissedVariant } from '@smp/db';
import type { PublishProducer } from '@smp/queue';

import type { TickResult } from '../processors/scheduler.processor';

// tick.publish (guide step 4.7, architecture 7): claims the due plans in the database, then adds
// their publish jobs with a delay up to the planned time. A job that cannot be added (Redis away)
// is not lost: its variant stays QUEUED, and the sweeper adds it after two minutes.

export interface DuePlans {
  claimDue(): Promise<{ queued: QueuedVariant[]; missed: MissedVariant[] }>;
}

/** Bursts are drained in up to this many batches per tick. */
const MAX_BATCHES = 10;

export class PublishTick {
  constructor(
    private readonly deps: {
      plans: DuePlans;
      producer: Pick<PublishProducer, 'publish'>;
      now: () => number;
      batchSize: number;
    },
  ) {}

  async run(): Promise<TickResult> {
    let queued = 0;
    let missed = 0;
    let enqueueFailed = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const claimed = await this.deps.plans.claimDue();
      queued += claimed.queued.length;
      missed += claimed.missed.length;
      const results = await Promise.allSettled(
        claimed.queued.map((variant) =>
          this.deps.producer.publish(
            {
              organizationId: variant.organizationId,
              workspaceId: variant.workspaceId,
              variantId: variant.variantId,
              scheduleVersion: variant.scheduleVersion,
              trigger: 'schedule',
            },
            { delayMs: variant.scheduledAt.getTime() - this.deps.now() },
          ),
        ),
      );
      enqueueFailed += results.filter((result) => result.status === 'rejected').length;
      if (claimed.queued.length < this.deps.batchSize && claimed.missed.length < this.deps.batchSize) {
        break;
      }
    }
    return { queued, missed, enqueueFailed };
  }
}
