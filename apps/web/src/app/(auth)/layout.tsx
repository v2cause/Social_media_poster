import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { LanguageSwitcher } from '@/components/language-switcher';

/** Sign-in pages: a centered card with the product name (guide step 1.9). */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('app');
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between p-4">
        <span className="font-semibold">{t('name')}</span>
        <LanguageSwitcher signedIn={false} />
      </header>
      <main className="flex flex-1 items-start justify-center p-4 pt-[8vh]">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
