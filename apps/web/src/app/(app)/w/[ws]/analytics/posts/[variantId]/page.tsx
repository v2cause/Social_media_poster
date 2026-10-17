import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { PostAnalyticsPage } from '@/features/analytics/post-analytics-page';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('analytics.post');
  return { title: t('title') };
}

export default async function PostAnalyticsRoute({
  params,
}: {
  params: Promise<{ ws: string; variantId: string }>;
}) {
  const { ws, variantId } = await params;
  if (!z.uuid().safeParse(variantId).success) {
    notFound();
  }
  const { workspace } = await getWorkspaceContext(ws);
  return <PostAnalyticsPage ws={ws} variantId={variantId} timeZone={workspace.timezone} />;
}
