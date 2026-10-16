import { getTranslations } from 'next-intl/server';

import { BrandPage } from '@/features/brand/brand-page';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('brand');
  return { title: t('title') };
}

export default async function BrandVoicesRoute({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { permissions } = await getWorkspaceContext(ws);
  return <BrandPage ws={ws} canManage={permissions.includes('brand_voice.manage')} />;
}
