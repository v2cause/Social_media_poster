import { getTranslations } from 'next-intl/server';

import { SecurityPage } from '@/components/account/security-page';

export async function generateMetadata() {
  const t = await getTranslations('account.security');
  return { title: t('title') };
}

export default function AccountSecurityPage() {
  return <SecurityPage />;
}
