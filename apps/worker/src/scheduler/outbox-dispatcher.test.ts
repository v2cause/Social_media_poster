import { randomUUID } from 'node:crypto';

import type { PendingOutboxEvent } from '@smp/db';
import type { LiveEvent, LiveEventPublisher, PublishProducer, PublishVariant } from '@smp/queue';
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

const recordingLive = (events: [string, LiveEvent][]): LiveEventPublisher =>
  ({
    publish: (workspaceId: string, live: LiveEvent) => {
      events.push([workspaceId, live]);
      return Promise.resolve();
    },
  }) as unknown as LiveEventPublisher;

const dispatcherOf = (jobs: PublishVariant[] = [], live: [string, LiveEvent][] = []): OutboxDispatcher =>
  new OutboxDispatcher({ publish: recordingProducer(jobs), live: recordingLive(live) });

describe('OutboxDispatcher', () => {
  it('adds the publish job of a requested schedule version', async () => {
    const jobs: PublishVariant[] = [];
    const requested = event('publish.requested', {
      variantId: randomUUID(),
      scheduleVersion: 4,
      trigger: 'now',
    });

    await dispatcherOf(jobs).dispatch(requested);

    expect(jobs).toEqual([
      {
        organizationId: requested.organizationId,
        workspaceId: requested.workspaceId,
        ...(requested.payload as object),
      },
    ]);
  });

  it('passes a status change on to the live events of its workspace', async () => {
    const live: [string, LiveEvent][] = [];
    const changed = event('variant.status', {
      variantId: randomUUID(),
      postId: randomUUID(),
      status: 'QUEUED',
      scheduleVersion: 2,
    });

    await dispatcherOf([], live).dispatch(changed);

    expect(live).toEqual([[changed.workspaceId, { type: 'variant.status', ...(changed.payload as object) }]]);
  });

  it('fails on a broken payload or an unknown type, so the event stays in the outbox', async () => {
    const dispatcher = dispatcherOf();

    await expect(dispatcher.dispatch(event('publish.requested', { variantId: 'x' }))).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(dispatcher.dispatch(event('variant.vanished', {}))).rejects.toBeInstanceOf(
      UnknownOutboxEventError,
    );
  });
});
