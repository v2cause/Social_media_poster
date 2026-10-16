import type { StaleVariant } from '@smp/db';
import { publishJobId, type PublishProducer } from '@smp/queue';
import type { Queue } from 'bullmq';

import type { TickResult } from '../processors/scheduler.processor';

// tick.sweep-queued (guide step 4.7): looks after the variants whose job may be lost. Queued for
// more than two minutes, publishing with an expired lease (a worker died), or retrying for longer
// than the longest backoff. A missing job is added again; one that failed or completed under the
// same id is started again with job.retry(), because BullMQ ignores an add for an existing id.
// The job checks status and schedule version itself, so a second run is harmless; after an
// expired lease it starts with the reconcile (guide step 4.8).

export interface StalePlans {
  stale(): Promise<StaleVariant[]>;
}

export class Sweeper {
  constructor(
    private readonly deps: {
      plans: StalePlans;
      queue: Pick<Queue, 'getJob'>;
      producer: Pick<PublishProducer, 'publish'>;
    },
  ) {}

  async run(): Promise<TickResult> {
    const stale = await this.deps.plans.stale();
    const counts = { checked: stale.length, added: 0, restarted: 0, running: 0, failed: 0 };
    for (const variant of stale) {
      try {
        const outcome = await this.sweep(variant);
        counts[outcome] += 1;
      } catch {
        // Another sweeper got there first, or Redis is away; the next tick looks again.
        counts.failed += 1;
      }
    }
    return counts;
  }

  private async sweep(variant: StaleVariant): Promise<'added' | 'restarted' | 'running'> {
    const job = await this.deps.queue.getJob(publishJobId(variant.variantId, variant.scheduleVersion));
    const state = job ? await job.getState() : 'unknown';
    if (job && (state === 'failed' || state === 'completed')) {
      await job.retry(state);
      return 'restarted';
    }
    if (!job || state === 'unknown') {
      await this.deps.producer.publish({
        organizationId: variant.organizationId,
        workspaceId: variant.workspaceId,
        variantId: variant.variantId,
        scheduleVersion: variant.scheduleVersion,
        trigger: 'sweep',
      });
      return 'added';
    }
    return 'running';
  }
}
