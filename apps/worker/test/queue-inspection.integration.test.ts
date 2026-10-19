import { randomUUID } from 'node:crypto';

import { NOTIFICATIONS_QUEUE, PUBLISH_DEAD_LETTER_QUEUE, PublishDeadLetters } from '@smp/queue';
import { startRedis, type StartedRedis } from '@smp/testing';
import { Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QueueInspection } from '../src/infrastructure/queue-inspection';

// Guide step 8.7 on Redis: pnpm queues counts every queue, lists the dead letters and the failed
// jobs of a queue without their data, and removes the dead letters an operator has looked at,
// all or those that failed before a time.

describe('the queues for the operators', () => {
  let redis: StartedRedis | undefined;
  const opened: { close: () => Promise<unknown> }[] = [];

  const url = (): string => {
    if (!redis) {
      throw new Error('not started');
    }
    return redis.url;
  };
  const queueOf = (name: string): Queue => {
    const queue = new Queue(name, { connection: { url: url() } });
    opened.push(queue);
    return queue;
  };
  const letter = (failedAt: string) => ({
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    variantId: randomUUID(),
    scheduleVersion: 1,
    trigger: 'schedule' as const,
    failedReason: 'The publish failed for good: REAUTH_REQUIRED.',
    attemptsMade: 1,
    failedAt,
  });

  beforeAll(async () => {
    redis = await startRedis();
  }, 120_000);

  afterAll(async () => {
    for (const item of opened.reverse()) {
      await item.close();
    }
    await redis?.stop();
  });

  it('counts, lists without the data of a job, and removes what was looked at', async () => {
    const deadLetters = new PublishDeadLetters(queueOf(PUBLISH_DEAD_LETTER_QUEUE));
    const early = letter('2026-10-19T05:00:00.000Z');
    const late = letter('2026-10-19T06:00:00.000Z');
    await deadLetters.add(early);
    await deadLetters.add(late);

    const notifications = queueOf(NOTIFICATIONS_QUEUE);
    const events = new QueueEvents(NOTIFICATIONS_QUEUE, { connection: { url: url() } });
    opened.push(events);
    await events.waitUntilReady();
    const worker = new Worker(
      NOTIFICATIONS_QUEUE,
      () => Promise.reject(new UnrecoverableError('smtp refused the connection')),
      { connection: { url: url(), maxRetriesPerRequest: null } },
    );
    opened.push(worker);
    const job = await notifications.add('notify.deliver', { secret: 'sealed-link' });
    await expect(job.waitUntilFinished(events)).rejects.toThrow('smtp refused');

    const inspection = new QueueInspection(url());
    opened.push(inspection);

    const counts = await inspection.counts([PUBLISH_DEAD_LETTER_QUEUE, NOTIFICATIONS_QUEUE]);
    expect(counts).toEqual([
      expect.objectContaining({ queue: PUBLISH_DEAD_LETTER_QUEUE, waiting: 2, failed: 0 }),
      expect.objectContaining({ queue: NOTIFICATIONS_QUEUE, waiting: 0, failed: 1 }),
    ]);

    const listed = await inspection.deadLetters(10);
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantId: early.variantId, failedReason: early.failedReason }),
        expect.objectContaining({ variantId: late.variantId, failedAt: late.failedAt }),
      ]),
    );

    const failed = await inspection.failed(NOTIFICATIONS_QUEUE, 10);
    expect(failed).toEqual([
      expect.objectContaining({
        id: job.id,
        name: 'notify.deliver',
        failedReason: 'smtp refused the connection',
      }),
    ]);
    expect(JSON.stringify(failed)).not.toContain('sealed-link');

    await expect(inspection.removeDeadLetters(new Date('2026-10-19T05:30:00Z'))).resolves.toBe(1);
    expect((await inspection.deadLetters(10)).map((row) => row['variantId'])).toEqual([late.variantId]);
    await expect(inspection.removeDeadLetters()).resolves.toBe(1);
    await expect(inspection.deadLetters(10)).resolves.toEqual([]);
  }, 60_000);
});
