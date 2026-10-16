import { getTranslations } from 'next-intl/server';

import { ResetPasswordForm } from '@/components/auth/reset-password-form';

export async function generateMetadata() {
  const t = await getTranslations('auth.resetPassword');
  return { title: t('title') };
}

/** Better Auth sends the user here with ?token=..., or with ?error=INVALID_TOKEN. */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return <ResetPasswordForm token={error ? null : (token ?? null)} />;
}
