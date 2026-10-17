import { getTranslations } from 'next-intl/server';

import { AdminPage } from '@/features/admin/admin-page';

export async function generateMetadata() {
  const t = await getTranslations('admin');
  return { title: t('title') };
}

export default function AdminRoute() {
  return <AdminPage />;
}
