import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { LoginForm, type VerificationOutcome } from '@/components/auth/login-form';
import { getSession, homePath } from '@/lib/server/api';
import { safeNext } from '@/lib/safe-next';

export async function generateMetadata() {
  const t = await getTranslations('auth.login');
  return { title: t('title') };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; verified?: string; error?: string }>;
}) {
  const { next, verified, error } = await searchParams;
  if (await getSession()) {
    redirect(next ? safeNext(next) : await homePath());
  }
  // The verification link leads here (verificationCallback); Better Auth adds error when it failed.
  const verification: VerificationOutcome = verified === '1' ? (error ? 'failed' : 'verified') : null;
  return <LoginForm next={next ? safeNext(next) : null} verification={verification} />;
}
