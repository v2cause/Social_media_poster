'use client';

import {
  getNotificationsPreferencesQueryKey,
  useNotificationsPreferences,
  useNotificationsSetPreferences,
} from '@smp/api-client';
import type { NotificationPreferenceDto } from '@smp/contracts';
import {
  Card,
  CardContent,
  Checkbox,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { MESSAGE_KEYS } from './notification-link';

type Channel = 'inApp' | 'email';

/** Per type of notification: in the app, by email, both or neither (guide step 4.9). */
export function NotificationSettingsPage() {
  const t = useTranslations('notifications.settings');
  const states = useTranslations('states');
  const queryClient = useQueryClient();
  const preferences = useNotificationsPreferences();
  const save = useNotificationsSetPreferences({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getNotificationsPreferencesQueryKey(), data);
        toast.success(t('saved'));
      },
      onError: () => {
        toast.error(t('saveError'));
      },
    },
  });

  const change = (preference: NotificationPreferenceDto, channel: Channel, enabled: boolean) => {
    save.mutate({ data: { preferences: [{ ...preference, [channel]: enabled }] } });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>
      <Card>
        <CardContent className="pt-6">
          {preferences.isPending ? (
            <LoadingState label={states('loading')} rows={4} />
          ) : preferences.isError ? (
            <ErrorState title={t('loadError')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('event')}</TableHead>
                  <TableHead className="w-20 whitespace-nowrap text-center sm:w-28">{t('inApp')}</TableHead>
                  <TableHead className="w-20 whitespace-nowrap text-center sm:w-28">{t('email')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preferences.data.preferences.map((preference) => {
                  const key = MESSAGE_KEYS[preference.type];
                  const event = t(`types.${key}.title`);
                  return (
                    <TableRow key={preference.type}>
                      <TableCell>
                        <p className="font-medium">{event}</p>
                        <p className="text-sm text-muted-foreground">{t(`types.${key}.description`)}</p>
                      </TableCell>
                      {(['inApp', 'email'] as const).map((channel) => (
                        <TableCell key={channel} className="text-center">
                          <Checkbox
                            checked={preference[channel]}
                            disabled={save.isPending}
                            aria-label={t('toggle', { event, channel: t(channel) })}
                            onChange={(event_) => {
                              change(preference, channel, event_.target.checked);
                            }}
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
