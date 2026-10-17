import type { NotificationContentDto, NotificationDto } from '@smp/contracts';

// Where a notification leads (guide step 4.9): a connection to the accounts page of its
// workspace, a post to the post.

export function hrefOf(notification: NotificationDto): string {
  const base = `/w/${encodeURIComponent(notification.workspace.slug)}`;
  const { content } = notification;
  return content.type === 'token-expiring' || content.type === 'reauth-required'
    ? `${base}/accounts`
    : `${base}/posts/${encodeURIComponent(content.postId)}`;
}

/** The message keys of a type in the namespace "notifications". */
export const MESSAGE_KEYS = {
  'token-expiring': 'tokenExpiring',
  'reauth-required': 'reauthRequired',
  'publish-failed': 'publishFailed',
  'needs-attention': 'needsAttention',
} as const satisfies Record<NotificationContentDto['type'], string>;

/** Names three accounts at most; the others appear as a count, like in the emails. */
export const NAMED_ACCOUNTS = 3;
