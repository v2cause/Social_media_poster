'use client';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Button } from '@smp/ui';
import { Languages } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { LOCALES, type Locale } from '@/i18n/locale';
import { authClient } from '@/lib/auth-client';
import { writeLocaleCookie } from '@/lib/locale-cookie';

/**
 * Switches the interface language. The cookie decides for the next render; signed-in users also
 * get the language in their profile, so emails follow it.
 */
export function LanguageSwitcher({ signedIn }: { signedIn: boolean }) {
  const t = useTranslations();
  const current = useLocale();
  const router = useRouter();

  const choose = async (locale: Locale) => {
    writeLocaleCookie(locale);
    if (signedIn) {
      await authClient.updateUser({ locale }).catch(() => undefined);
    }
    router.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('shell.language')}>
          <Languages aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map((locale) => (
          <DropdownMenuItem
            key={locale}
            lang={locale}
            aria-current={locale === current ? 'true' : undefined}
            onSelect={() => void choose(locale)}
          >
            {t(`languages.${locale}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
