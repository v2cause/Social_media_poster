import type { OutboxEventPayloads, OutboxEventType } from '@smp/core';
import type { PendingOutboxEvent } from '@smp/db';
import type { PublishProducer } from '@smp/queue';
import { z } from 'zod';

// Routes the events of the outbox to their jobs (guide step 4.3). A route validates the payload
// and adds its job under a deterministic id, so dispatching the same event twice (after a failed
// commit of the relay) adds one job. An event without a route fails and stays in the outbox with
// its error, visible instead of lost.

const payloadSchemas = {
  'publish.requested': z.object({
    variantId: z.uuid(),
    scheduleVersion: z.number().int().nonnegative(),
    trigger: z.enum(['now', 'retry']),
  }),
} as const satisfies { [T in OutboxEventType]: z.ZodType<OutboxEventPayloads[T]> };

export class UnknownOutboxEventError extends Error {
  constructor(type: string) {
    super(`No route for the outbox event type ${type}.`);
    this.name = 'UnknownOutboxEventError';
  }
}

export class OutboxDispatcher {
  constructor(private readonly producers: { publish: PublishProducer }) {}

  async dispatch(event: PendingOutboxEvent): Promise<void> {
    switch (event.type) {
      case 'publish.requested': {
        const payload = payloadSchemas['publish.requested'].parse(event.payload);
        await this.producers.publish.publish({
          organizationId: event.organizationId,
          workspaceId: event.workspaceId,
          ...payload,
        });
        return;
      }
      default:
        throw new UnknownOutboxEventError(event.type);
    }
  }
}
