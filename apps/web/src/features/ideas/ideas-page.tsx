'use client';

import { getIdeasListQueryKey, useIdeasGenerate, useIdeasList, useIdeasUpdate } from '@smp/api-client';
import type { IdeaDto } from '@smp/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  LoadingState,
  cn,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Lightbulb, PenSquare } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { PlatformMark } from '@/features/publishing/platform-mark';
import { useErrorMessage } from '@/lib/use-error-message';

// The ideas of a workspace (guide step 2.9): a grid of cards with a status filter. The AI suggests
// ten at a time; each idea can be saved, discarded or turned into a post, which opens the
// composer prefilled with it.

const FILTERS = ['open', 'SAVED', 'USED', 'DISCARDED', 'all'] as const;
type Filter = (typeof FILTERS)[number];

const matches = (idea: IdeaDto, filter: Filter): boolean => {
  switch (filter) {
    case 'all':
      return true;
    case 'open':
      return idea.status === 'NEW' || idea.status === 'SAVED';
    default:
      return idea.status === filter;
  }
};

export interface IdeasPageProps {
  ws: string;
  /** idea.write: save, discard and restore. */
  canWrite: boolean;
  /** ai.use: generate new ideas. */
  canUseAi: boolean;
  /** post.write: open the composer with an idea. */
  canPost: boolean;
}

export function IdeasPage(props: IdeasPageProps) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('open');
  const ideas = useIdeasList(props.ws);
  const generate = useIdeasGenerate();

  const refresh = () => queryClient.invalidateQueries({ queryKey: getIdeasListQueryKey(props.ws) });

  const suggest = async () => {
    try {
      const result = await generate.mutateAsync({ ws: props.ws, data: { count: 10 } });
      toast.success(t('ideas.generated', { count: result.ideas.length }), {
        description: result.duplicates > 0 ? t('ideas.duplicates', { count: result.duplicates }) : undefined,
      });
      setFilter('open');
    } catch (error) {
      toast.error(errorMessage(error));
    }
    await refresh();
  };

  const all = ideas.data?.ideas ?? [];
  const shown = all.filter((idea) => matches(idea, filter));

  let content;
  if (ideas.isPending) {
    content = <LoadingState label={t('states.loading')} />;
  } else if (ideas.isError) {
    content = (
      <ErrorState
        title={t('states.error')}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void ideas.refetch();
            }}
          >
            {t('actions.retry')}
          </Button>
        }
      />
    );
  } else if (all.length === 0) {
    content = <EmptyState title={t('ideas.empty')} description={t('ideas.emptyHint')} />;
  } else if (shown.length === 0) {
    content = <EmptyState title={t('ideas.emptyFiltered')} />;
  } else {
    content = (
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((idea) => (
          <li key={idea.id} className="flex">
            <IdeaCard idea={idea} {...props} onChanged={refresh} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('ideas.title')}</h1>
          <p className="max-w-2xl text-muted-foreground">{t('ideas.description')}</p>
        </div>
        {props.canUseAi ? (
          <Button type="button" loading={generate.isPending} onClick={() => void suggest()}>
            <Lightbulb aria-hidden="true" />
            {generate.isPending ? t('ideas.generating') : t('ideas.generate')}
          </Button>
        ) : null}
      </div>

      <div role="group" aria-label={t('ideas.filter')} className="flex flex-wrap gap-2">
        {FILTERS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={filter === candidate}
            onClick={() => {
              setFilter(candidate);
            }}
            className={cn(
              'rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              filter === candidate
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background hover:bg-muted',
            )}
          >
            {t(`ideas.filters.${candidate}`)}
          </button>
        ))}
      </div>

      {content}
    </div>
  );
}

function IdeaCard(props: IdeasPageProps & { idea: IdeaDto; onChanged: () => Promise<void> }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const update = useIdeasUpdate();
  const { idea } = props;

  const setStatus = async (status: IdeaDto['status'], done: string) => {
    try {
      await update.mutateAsync({ ws: props.ws, ideaId: idea.id, data: { version: idea.version, status } });
      toast.success(done);
    } catch (error) {
      toast.error(errorMessage(error));
    }
    await props.onChanged();
  };

  const open = idea.status === 'NEW' || idea.status === 'SAVED';

  return (
    <Card className="flex w-full flex-col">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={idea.status === 'NEW' ? 'default' : 'muted'}>
            {t(`ideas.status.${idea.status}`)}
          </Badge>
          {idea.pillar ? <Badge variant="muted">{idea.pillar}</Badge> : null}
          {idea.format ? <Badge variant="muted">{idea.format}</Badge> : null}
          {idea.source === 'MANUAL' ? <Badge variant="muted">{t('ideas.manual')}</Badge> : null}
        </div>
        <CardTitle className="text-base">{idea.title}</CardTitle>
        {idea.angle ? <CardDescription>{idea.angle}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 text-sm">
        {idea.whyNow ? (
          <p>
            <span className="font-medium">{t('ideas.whyNow')}:</span> {idea.whyNow}
          </p>
        ) : null}
        {idea.basedOn.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('ideas.basedOn', { items: idea.basedOn.join(', ') })}
          </p>
        ) : null}
        {idea.basedOnPosts.length > 0 ? (
          <ul
            aria-label={t('ideas.basedOnPosts')}
            className="flex flex-col gap-1 text-xs text-muted-foreground"
          >
            {idea.basedOnPosts.map((post) => (
              <li key={post.variantId} className="flex min-w-0 items-center gap-2">
                <PlatformMark platform={post.platform} size="xs" />
                <Link
                  href={`/w/${props.ws}/analytics/posts/${post.variantId}`}
                  className="truncate hover:text-foreground hover:underline"
                >
                  {t('ideas.topPost', { preview: post.preview === '' ? t('posts.noText') : post.preview })}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {idea.suggestedPlatforms.length > 0 ? (
          <ul aria-label={t('ideas.platforms')} className="flex flex-wrap gap-1">
            {idea.suggestedPlatforms.map((platform) => (
              <li key={platform}>
                <Badge variant="muted">{t(`platforms.${platform}`)}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
      <CardFooter
        role="group"
        aria-label={t('ideas.actions', { title: idea.title })}
        className="flex flex-wrap gap-2"
      >
        {props.canPost && idea.status !== 'DISCARDED' ? (
          <Button asChild size="sm">
            <Link href={`/w/${props.ws}/compose?idea=${idea.id}`}>
              <PenSquare aria-hidden="true" />
              {t('ideas.createPost')}
            </Link>
          </Button>
        ) : null}
        {props.canWrite && idea.status === 'NEW' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => void setStatus('SAVED', t('ideas.savedToast'))}
          >
            {t('ideas.save')}
          </Button>
        ) : null}
        {props.canWrite && open ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => void setStatus('DISCARDED', t('ideas.discardedToast'))}
          >
            {t('ideas.discard')}
          </Button>
        ) : null}
        {props.canWrite && idea.status === 'DISCARDED' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => void setStatus('NEW', t('ideas.restoredToast'))}
          >
            {t('ideas.restore')}
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
