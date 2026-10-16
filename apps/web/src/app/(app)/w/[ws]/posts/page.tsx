import { getTranslations } from 'next-intl/server';

import { PostList } from '@/features/posts/post-list';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('posts');
  return { title: t('title') };
}

export default async function PostsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const context = await getWorkspaceContext(ws);
  return <PostList ws={ws} canWrite={context.permissions.includes('post.write')} />;
}
