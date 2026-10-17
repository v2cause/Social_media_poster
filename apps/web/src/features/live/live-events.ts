import {
  getAccountsListQueryKey,
  getNotificationsListQueryKey,
  getPostsGetQueryKey,
  getPostsListQueryKey,
  getPublishingListQueryKey,
  getXBrowserLoginGetQueryKey,
} from '@smp/api-client';
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
      // The variant list covers the post list, the calendar and the dashboard (guide step 4.11).
      return [
        getPostsListQueryKey(slug),
        getPostsGetQueryKey(slug, event.postId),
        getPublishingListQueryKey(slug),
      ];
    case 'notification.created':
      return [getNotificationsListQueryKey()];
    case 'xb.login':
      // The dialog of the login reads its status; once it succeeded, an account is connected (guide
      // step 6.4).
      return [
        getXBrowserLoginGetQueryKey(slug, event.loginSessionId),
        ...(event.status === 'SUCCEEDED' ? [getAccountsListQueryKey(slug)] : []),
      ];
  }
}

/** After a lost connection every query an event could have changed is stale. */
export const queryKeysAfterReconnect = (slug: string): QueryKey[] => [
  getPostsListQueryKey(slug),
  getPublishingListQueryKey(slug),
  getNotificationsListQueryKey(),
];
