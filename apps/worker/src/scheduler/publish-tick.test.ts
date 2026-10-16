import { randomUUID } from 'node:crypto';

import type { QueuedVariant } from '@smp/db';
import type { PublishVariant } from '@smp/queue';
import { describe, expect, it } from 'vitest';

import { PublishTick } from './publish-tick';

// Guide step 4.7: the tick adds the job of every claimed variant, with a delay up to its time.

const NOW = Date.parse('2026-10-16T12:00:00Z');

const queued = (offsetMs: number): QueuedVariant => ({
  variantId: randomUUID(),
  workspaceId: randomUUID(),
  organizationId: randomUUID(),
  scheduleVersion: 2,
  scheduledAt: new Date(NOW + offsetMs),
});

describe('PublishTick', () => {
  it('adds a job per queued variant, delayed up to its time, and drains a burst', async () => {
    const batches = [[queued(20_000), queued(-5_000)], [queued(0)], []];
    const jobs: [PublishVariant, number | undefined][] = [];
    const tick = new PublishTick({
      plans: { claimDue: () => Promise.resolve({ queued: batches.shift() ?? [], missed: [] }) },
      producer: {
        publish: (job, options) => {
          jobs.push([job, options?.delayMs]);
          return Promise.resolve();
        },
      },
      now: () => NOW,
      batchSize: 2,
    });

    await expect(tick.run()).resolves.toEqual({ queued: 3, missed: 0, enqueueFailed: 0 });
    expect(jobs.map(([job, delay]) => [job.trigger, job.scheduleVersion, delay])).toEqual([
      ['schedule', 2, 20_000],
      ['schedule', 2, -5_000],
      ['schedule', 2, 0],
    ]);
  });

  it('counts the jobs it could not add and leaves them to the sweeper', async () => {
    const tick = new PublishTick({
      plans: { claimDue: () => Promise.resolve({ queued: [queued(0), queued(0)], missed: [] }) },
      producer: { publish: () => Promise.reject(new Error('Redis is away')) },
      now: () => NOW,
      batchSize: 500,
    });

    await expect(tick.run()).resolves.toEqual({ queued: 2, missed: 0, enqueueFailed: 2 });
  });
});
