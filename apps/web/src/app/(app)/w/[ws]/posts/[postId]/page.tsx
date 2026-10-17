import { toLocale } from '@smp/contracts';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { ComposerPage } from '@/features/composer/composer-page';
import { getComposerOptions, getPost, getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('composer');
  return { title: t('editTitle') };
}

/** A saved post in the composer (guide step 2.8); viewers see it read-only. */
export default async function PostPage({ params }: { params: Promise<{ ws: string; postId: string }> }) {
  const { ws, postId } = await params;
  if (!z.uuid().safeParse(postId).success) {
    notFound();
  }
  const [context, options, post] = await Promise.all([
    getWorkspaceContext(ws),
    getComposerOptions(ws),
    getPost(ws, postId),
  ]);

  return (
    <ComposerPage
      key={post.id}
      ws={ws}
      workspaceName={context.workspace.name}
      contentLanguage={toLocale(context.workspace.contentLanguage)}
      canWrite={context.permissions.includes('post.write')}
      canUseAi={context.permissions.includes('ai.use')}
      canSchedule={context.permissions.includes('post.schedule')}
      canPublish={context.permissions.includes('post.publish')}
      timeZone={context.workspace.timezone}
      styles={options.styles}
      voices={options.voices}
      post={post}
      idea={null}
    />
  );
}
