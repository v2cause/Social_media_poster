import { getTranslations } from 'next-intl/server';

import { VerifyEmailCard } from '@/components/auth/verify-email-card';
import { safeNext } from '@/lib/safe-next';

export async function generateMetadata() {
  const t = await getTranslations('auth.verifyEmail');
  return { title: t('title') };
}

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; next?: string }>;
}) {
  const { email, next } = await searchParams;
  return <VerifyEmailCard email={email ?? null} next={next ? safeNext(next) : '/onboarding'} />;
}
