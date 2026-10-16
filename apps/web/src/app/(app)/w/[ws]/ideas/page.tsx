import { getTranslations } from 'next-intl/server';

import { IdeasPage } from '@/features/ideas/ideas-page';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('ideas');
  return { title: t('title') };
}

export default async function IdeasRoute({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { permissions } = await getWorkspaceContext(ws);
  return (
    <IdeasPage
      ws={ws}
      canWrite={permissions.includes('idea.write')}
      canUseAi={permissions.includes('ai.use')}
      canPost={permissions.includes('post.write')}
    />
  );
}
