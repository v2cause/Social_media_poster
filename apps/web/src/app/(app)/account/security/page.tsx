import { getTranslations } from 'next-intl/server';

import { SecurityPage } from '@/components/account/security-page';

export async function generateMetadata() {
  const t = await getTranslations('account.security');
  return { title: t('title') };
}

/** ?required=two-factor: an organization of the user requires a second factor (guide step 8.4). */
export default async function AccountSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const { required } = await searchParams;
  return <SecurityPage twoFactorRequired={required === 'two-factor'} />;
}
