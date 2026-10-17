import { getTranslations } from 'next-intl/server';

import { SettingsPage } from '@/features/settings/settings-page';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('settings');
  return { title: t('title') };
}

export default async function SettingsRoute({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { permissions } = await getWorkspaceContext(ws);
  return <SettingsPage ws={ws} canEnableXBrowser={permissions.includes('x_browser.enable')} />;
}
