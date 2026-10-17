import { getNotificationsListQueryKey, getPostsGetQueryKey, getPostsListQueryKey } from '@smp/api-client';
import { liveEventDtoSchema, type LiveEventDto } from '@smp/contracts';
import type { QueryKey } from '@tanstack/react-query';

// The live events of a workspace in the browser (guide step 4.10): each one names the queries
// whose data it changed, and those are fetched again.

/** The data of a server-sent event, checked against the contract; null for anything else. */
export function parseLiveEvent(data: string): LiveEventDto | null {
  try {
    const parsed = liveEventDtoSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The queries an event makes stale. */
export function queryKeysOf(event: LiveEventDto, slug: string): QueryKey[] {
  switch (event.type) {
    case 'variant.status':
      return [getPostsListQueryKey(slug), getPostsGetQueryKey(slug, event.postId)];
    case 'notification.created':
      return [getNotificationsListQueryKey()];
  }
}

/** After a lost connection every query an event could have changed is stale. */
export const queryKeysAfterReconnect = (slug: string): QueryKey[] => [
  getPostsListQueryKey(slug),
  getNotificationsListQueryKey(),
];
