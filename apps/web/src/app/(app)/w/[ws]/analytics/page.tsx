import { getTranslations } from 'next-intl/server';

import { AnalyticsPage } from '@/features/analytics/analytics-page';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('analytics');
  return { title: t('title') };
}

export default async function AnalyticsRoute({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { workspace } = await getWorkspaceContext(ws);
  return <AnalyticsPage ws={ws} timeZone={workspace.timezone} />;
}
