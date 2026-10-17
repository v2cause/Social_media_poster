import { getTranslations } from 'next-intl/server';

import { NotificationSettingsPage } from '@/features/notifications/notification-settings-page';

export async function generateMetadata() {
  const t = await getTranslations('notifications.settings');
  return { title: t('title') };
}

export default function AccountNotificationsPage() {
  return <NotificationSettingsPage />;
}
