import { getTranslations } from 'next-intl/server';

import { MediaLibraryPage } from '@/features/media/media-library-page';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('media');
  return { title: t('title') };
}

export default async function MediaRoute({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { permissions } = await getWorkspaceContext(ws);
  return (
    <MediaLibraryPage
      ws={ws}
      canWrite={permissions.includes('media.write')}
      canUseAi={permissions.includes('ai.use')}
    />
  );
}
