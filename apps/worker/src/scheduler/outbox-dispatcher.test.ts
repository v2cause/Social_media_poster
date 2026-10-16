import { randomUUID } from 'node:crypto';

import type { PendingOutboxEvent } from '@smp/db';
import type { PublishProducer, PublishVariant } from '@smp/queue';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { OutboxDispatcher, UnknownOutboxEventError } from './outbox-dispatcher';

// Guide step 4.3: the relay hands each outbox event to its route, which adds the job.

const event = (type: string, payload: unknown): PendingOutboxEvent => ({
  id: randomUUID(),
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  type,
  payload,
  attempts: 0,
  createdAt: new Date('2026-10-16T12:00:00Z'),
});

const recordingProducer = (jobs: PublishVariant[]): PublishProducer =>
  ({
    publish: (job: PublishVariant) => {
      jobs.push(job);
      return Promise.resolve();
    },
  }) as unknown as PublishProducer;

describe('OutboxDispatcher', () => {
  it('adds the publish job of a requested schedule version', async () => {
    const jobs: PublishVariant[] = [];
    const requested = event('publish.requested', {
      variantId: randomUUID(),
      scheduleVersion: 4,
      trigger: 'now',
    });

    await new OutboxDispatcher({ publish: recordingProducer(jobs) }).dispatch(requested);

    expect(jobs).toEqual([
      {
        organizationId: requested.organizationId,
        workspaceId: requested.workspaceId,
        ...(requested.payload as object),
      },
    ]);
  });

  it('fails on a broken payload or an unknown type, so the event stays in the outbox', async () => {
    const dispatcher = new OutboxDispatcher({ publish: recordingProducer([]) });

    await expect(dispatcher.dispatch(event('publish.requested', { variantId: 'x' }))).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(dispatcher.dispatch(event('variant.vanished', {}))).rejects.toBeInstanceOf(
      UnknownOutboxEventError,
    );
  });
});
