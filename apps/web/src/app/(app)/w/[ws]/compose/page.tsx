import { toLocale } from '@smp/contracts';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { ComposerPage } from '@/features/composer/composer-page';
import { getComposerOptions, getIdea, getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('composer');
  return { title: t('title') };
}

/** A new post; with ?idea=<id> prefilled from an idea (guide steps 2.8 and 2.9). */
export default async function ComposePage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ idea?: string | string[] }>;
}) {
  const [{ ws }, query] = await Promise.all([params, searchParams]);
  const ideaId = z.uuid().safeParse(query.idea);
  const [context, options, idea] = await Promise.all([
    getWorkspaceContext(ws),
    getComposerOptions(ws),
    ideaId.success ? getIdea(ws, ideaId.data) : null,
  ]);

  return (
    // A new mount per idea: moving from one prefilled composer to the next starts fresh.
    <ComposerPage
      key={idea?.id ?? 'new'}
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
      post={null}
      idea={idea}
    />
  );
}
