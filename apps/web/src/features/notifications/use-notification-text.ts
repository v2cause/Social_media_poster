import type { NotificationDto } from '@smp/contracts';
import { useFormatter, useTranslations } from 'next-intl';

import { useFailureReason } from '@/features/publishing/failure-reason';

import { MESSAGE_KEYS, NAMED_ACCOUNTS } from './notification-link';

// The text of a notification in the bell (guide step 4.9): a title, a line naming the accounts
// and the platform, and the beginning of the post or the affected plans.

export interface NotificationText {
  title: string;
  body: string;
  /** The beginning of the post, or how many plans are affected. */
  detail: string | null;
}

export function useNotificationText(): (notification: NotificationDto) => NotificationText {
  const t = useTranslations('notifications');
  const platforms = useTranslations('platforms');
  const format = useFormatter();
  const failureReason = useFailureReason();

  return ({ content }) => {
    const platform = platforms(content.platform);
    const named = content.accounts.slice(0, NAMED_ACCOUNTS).join(', ');
    const accounts =
      content.accounts.length === 0
        ? platform
        : content.accounts.length > NAMED_ACCOUNTS
          ? t('item.more', { names: named, count: content.accounts.length - NAMED_ACCOUNTS })
          : named;
    const key = MESSAGE_KEYS[content.type];
    const title = t(`item.${key}.title`);
    switch (content.type) {
      case 'token-expiring':
        return {
          title,
          body: t('item.tokenExpiring.body', {
            accounts,
            platform,
            date: format.dateTime(new Date(content.expiresAt), { dateStyle: 'long' }),
          }),
          detail: null,
        };
      case 'reauth-required':
        return {
          title,
          body: t('item.reauthRequired.body', { accounts, platform }),
          detail:
            content.scheduledVariants > 0
              ? t('item.reauthRequired.affected', { count: content.scheduledVariants })
              : null,
        };
      case 'publish-failed':
        return {
          title,
          body: t('item.publishFailed.body', {
            accounts,
            platform,
            reason: failureReason(content.failureCode),
          }),
          detail: content.preview,
        };
      case 'needs-attention':
        return {
          title,
          body: t('item.needsAttention.body', { accounts, platform }),
          detail: content.preview,
        };
    }
  };
}
