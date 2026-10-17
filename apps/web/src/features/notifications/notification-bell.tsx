'use client';

import {
  getNotificationsListQueryKey,
  useNotificationsList,
  useNotificationsMarkAllRead,
  useNotificationsMarkRead,
} from '@smp/api-client';
import { Button, cn, Popover, PopoverContent, PopoverTrigger, Spinner } from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useState } from 'react';

import { useLiveEvents } from '../live/live-events-provider';
import { hrefOf } from './notification-link';
import { useNotificationText } from './use-notification-text';

/** Asked again every 30 s while no live events arrive (guide step 4.10). */
const POLL_MS = 30_000;
/** The newest ones; older ones stay reachable through their pages later. */
const LIMIT = 10;

/** The bell of the app shell with the newest notifications of the user (guide step 4.9). */
export function NotificationBell() {
  const t = useTranslations('notifications.bell');
  const states = useTranslations('states');
  const format = useFormatter();
  const now = useNow({ updateInterval: POLL_MS });
  const textOf = useNotificationText();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { connected } = useLiveEvents();
  const list = useNotificationsList(
    { limit: LIMIT },
    { query: { refetchInterval: connected ? false : POLL_MS } },
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: getNotificationsListQueryKey() });
  const markRead = useNotificationsMarkRead({ mutation: { onSettled: refresh } });
  const markAllRead = useNotificationsMarkAllRead({ mutation: { onSettled: refresh } });
  const unread = list.data?.unread ?? 0;
  const items = list.data?.items ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={t('label', { count: unread })}>
          <Bell aria-hidden="true" />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
            >
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0 max-sm:w-[calc(100vw-2rem)]">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-sm font-medium">{t('title')}</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={unread === 0 || markAllRead.isPending}
            onClick={() => {
              markAllRead.mutate();
            }}
          >
            {t('markAllRead')}
          </Button>
        </div>
        {list.isPending ? (
          <div className="flex justify-center p-6">
            <Spinner label={states('loading')} />
          </div>
        ) : list.isError ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            {t('loadError')}
          </p>
        ) : items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {items.map((notification) => {
              const text = textOf(notification);
              const isUnread = notification.readAt === null;
              return (
                <li key={notification.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={hrefOf(notification)}
                    onClick={() => {
                      if (isUnread) {
                        markRead.mutate({ data: { ids: [notification.id] } });
                      }
                      setOpen(false);
                    }}
                    className="flex gap-3 px-4 py-3 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        isUnread ? 'bg-primary' : 'bg-transparent',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm', isUnread && 'font-medium')}>
                        {text.title}
                        {isUnread ? <span className="sr-only">{` (${t('unread')})`}</span> : null}
                      </span>
                      <span className="block text-sm text-muted-foreground">{text.body}</span>
                      {text.detail ? (
                        <span className="mt-1 block truncate text-xs text-muted-foreground">
                          {text.detail}
                        </span>
                      ) : null}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {`${notification.workspace.name}, ${format.relativeTime(new Date(notification.createdAt), now)}`}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <div className="border-t border-border px-4 py-2">
          <Link
            href="/account/notifications"
            onClick={() => {
              setOpen(false);
            }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t('settings')}
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
