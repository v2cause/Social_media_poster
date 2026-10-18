'use client';

import { Button } from '@smp/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { authClient } from '@/lib/auth-client';

/** Signs out on pages outside the app shell, for example the onboarding. */
export function SignOutButton() {
  const t = useTranslations('shell');
  const router = useRouter();
  const signOut = async () => {
    await authClient.signOut();
    router.push('/login');
    router.refresh();
  };
  return (
    <Button variant="ghost" size="sm" onClick={() => void signOut()}>
      {t('signOut')}
    </Button>
  );
}
