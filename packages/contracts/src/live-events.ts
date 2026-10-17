import { z } from 'zod';

import { variantStatusSchema } from './content';

// The live events of a workspace as the browser receives them from GET /api/w/:ws/events
// (guide step 4.10): server-sent events named by their type. They carry ids and the new status
// only; the browser invalidates the matching queries and reads the rest from the API.

const id = z.uuid();

export const liveEventDtoSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('variant.status'),
    variantId: id,
    postId: id,
    status: variantStatusSchema,
    scheduleVersion: z.number().int().nonnegative(),
  }),
  /** A new notification of the signed-in user in the app. */
  z.object({ type: z.literal('notification.created'), id }),
]);
export type LiveEventDto = z.infer<typeof liveEventDtoSchema>;

export const LIVE_EVENT_TYPES = [
  'variant.status',
  'notification.created',
] as const satisfies readonly LiveEventDto['type'][];
