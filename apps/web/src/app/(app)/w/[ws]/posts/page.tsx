import { getTranslations } from 'next-intl/server';

import { PostTable } from '@/features/posts/post-table';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('posts');
  return { title: t('title') };
}

export default async function PostsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { workspace, permissions } = await getWorkspaceContext(ws);
  return (
    <PostTable
      ws={ws}
      timeZone={workspace.timezone}
      canWrite={permissions.includes('post.write')}
      canSchedule={permissions.includes('post.schedule')}
      canDelete={permissions.includes('post.delete')}
    />
  );
}
