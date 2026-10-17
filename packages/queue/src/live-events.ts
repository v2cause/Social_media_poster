import type Redis from 'ioredis';
import { z } from 'zod';

// The live events of a workspace (architecture 7.4, guide step 4.10): Redis pub/sub on the
// channel ws:{workspaceId}:events. The outbox relay publishes the status of variants after the
// commit of a change, the role "notify" each new notification in the app; the SSE endpoint of the
// API passes them to the browsers of the workspace (a notification to its user only), which
// invalidate the matching queries. Events carry ids and the new status only.

export const liveEventChannel = (workspaceId: string): string => `ws:${workspaceId}:events`;

export const liveEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('variant.status'),
    variantId: z.uuid(),
    postId: z.uuid(),
    status: z.string().min(1).max(40),
    scheduleVersion: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('notification.created'),
    /** The notification in the app; it reaches the browsers of its user only. */
    id: z.uuid(),
    userId: z.uuid(),
  }),
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;

export const parseLiveEvent = (data: unknown): LiveEvent => liveEventSchema.parse(data);

export class LiveEventPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(workspaceId: string, event: LiveEvent): Promise<void> {
    await this.redis.publish(liveEventChannel(workspaceId), JSON.stringify(liveEventSchema.parse(event)));
  }
}
