'use client';

import { useTranslations } from 'next-intl';

import { XBrowserSection } from './x-browser-section';

// The settings of a workspace. Guide step 6.1 brings the section of the X browser; the other
// settings of architecture 11 have no step of the guide yet.

export function SettingsPage(props: { ws: string; canEnableXBrowser: boolean }) {
  const t = useTranslations('settings');
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>
      <XBrowserSection ws={props.ws} canEnable={props.canEnableXBrowser} />
    </div>
  );
}
