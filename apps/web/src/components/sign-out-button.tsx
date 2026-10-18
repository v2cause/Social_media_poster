'use client';

import { Button } from '@smp/ui';
import { useTranslations } from 'next-intl';

import { useSignOut } from '@/lib/use-sign-out';

/** Signs out on pages outside the app shell, for example the onboarding. */
export function SignOutButton() {
  const t = useTranslations('shell');
  const signOut = useSignOut();
  return (
    <Button variant="ghost" size="sm" onClick={() => void signOut()}>
      {t('signOut')}
    </Button>
  );
}
