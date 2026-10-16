import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { SignupForm } from '@/components/auth/signup-form';
import { getSession, homePath } from '@/lib/server/api';
import { safeNext } from '@/lib/safe-next';

export async function generateMetadata() {
  const t = await getTranslations('auth.signup');
  return { title: t('title') };
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; email?: string }>;
}) {
  const { next, email } = await searchParams;
  if (await getSession()) {
    redirect(next ? safeNext(next) : await homePath());
  }
  return <SignupForm next={next ? safeNext(next) : null} email={email ?? ''} />;
}
