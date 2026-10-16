import { VARIANT_STATUSES, type OutboxEventPayloads, type OutboxEventType } from '@smp/core';
import type { PendingOutboxEvent } from '@smp/db';
import {
  notificationRequestSchema,
  type LiveEventPublisher,
  type NotificationProducer,
  type PublishProducer,
} from '@smp/queue';
import { z } from 'zod';

// Routes the events of the outbox to their jobs (guide steps 4.3 and 4.9). A route validates the
// payload and adds its job under a deterministic id, so dispatching the same event twice (after a
// failed commit of the relay) adds one job. An event without a route fails and stays in the
// outbox with its error, visible instead of lost.

const payloadSchemas = {
  'publish.requested': z.object({
    variantId: z.uuid(),
    scheduleVersion: z.number().int().nonnegative(),
    trigger: z.enum(['now', 'retry', 'recheck']),
  }),
  'variant.status': z.object({
    variantId: z.uuid(),
    postId: z.uuid(),
    status: z.enum(VARIANT_STATUSES),
    scheduleVersion: z.number().int().nonnegative(),
  }),
  'notification.requested': notificationRequestSchema,
} as const satisfies { [T in OutboxEventType]: z.ZodType<OutboxEventPayloads[T]> };

export class UnknownOutboxEventError extends Error {
  constructor(type: string) {
    super(`No route for the outbox event type ${type}.`);
    this.name = 'UnknownOutboxEventError';
  }
}

export class OutboxDispatcher {
  constructor(
    private readonly producers: {
      publish: PublishProducer;
      live: LiveEventPublisher;
      notifications: NotificationProducer;
    },
  ) {}

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
      case 'variant.status': {
        // Live only: a browser that misses it polls (guide step 4.10).
        const payload = payloadSchemas['variant.status'].parse(event.payload);
        await this.producers.live.publish(event.workspaceId, { type: 'variant.status', ...payload });
        return;
      }
      case 'notification.requested': {
        // The role "notify" finds the recipients (guide step 4.9).
        const request = payloadSchemas['notification.requested'].parse(event.payload);
        await this.producers.notifications.dispatchEvent({
          eventId: event.id,
          organizationId: event.organizationId,
          workspaceId: event.workspaceId,
          request,
        });
        return;
      }
      default:
        throw new UnknownOutboxEventError(event.type);
    }
  }
}
