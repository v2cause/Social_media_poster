import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { AccountAnalyticsPage } from '@/features/analytics/account-analytics-page';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('analytics.account');
  return { title: t('title') };
}

export default async function AccountAnalyticsRoute({
  params,
}: {
  params: Promise<{ ws: string; accountId: string }>;
}) {
  const { ws, accountId } = await params;
  if (!z.uuid().safeParse(accountId).success) {
    notFound();
  }
  const { workspace } = await getWorkspaceContext(ws);
  return <AccountAnalyticsPage ws={ws} accountId={accountId} timeZone={workspace.timezone} />;
}
