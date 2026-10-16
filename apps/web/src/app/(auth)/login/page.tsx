import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { LoginForm } from '@/components/auth/login-form';
import { getSession, homePath } from '@/lib/server/api';
import { safeNext } from '@/lib/safe-next';

export async function generateMetadata() {
  const t = await getTranslations('auth.login');
  return { title: t('title') };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getSession()) {
    redirect(next ? safeNext(next) : await homePath());
  }
  return <LoginForm next={next ? safeNext(next) : null} />;
}
