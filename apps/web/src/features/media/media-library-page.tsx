'use client';

import { getMediaListQueryKey, mediaList, type MediaListParams } from '@smp/api-client';
import { Button, EmptyState, ErrorState, LoadingState, cn } from '@smp/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { MediaCard } from './media-card';
import { MediaDropzone } from './media-dropzone';
import { UploadProgressList } from './upload-progress-list';
import { useUploads } from './use-uploads';

// The media library of a workspace (guide step 3.6): upload by drop or picker, a grid with
// thumbnails, status and use, and filters for used and unused media. While files are being
// checked, the list asks again every few seconds.

const FILTERS = ['all', 'used', 'unused', 'rejected'] as const;
type Filter = (typeof FILTERS)[number];

const PAGE_SIZE = 30;
const POLL_MS = 2000;

const paramsOf = (filter: Filter): MediaListParams =>
  filter === 'rejected' ? { status: 'REJECTED' } : filter === 'all' ? {} : { usage: filter };

export interface MediaLibraryPageProps {
  ws: string;
  /** media.write: upload, change and delete. */
  canWrite: boolean;
  /** ai.use: suggest alt texts. */
  canUseAi: boolean;
}

export function MediaLibraryPage(props: MediaLibraryPageProps) {
  const t = useTranslations('media');
  const tStates = useTranslations('states');
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const params = paramsOf(filter);

  const library = useInfiniteQuery({
    queryKey: [...getMediaListQueryKey(props.ws, params), 'pages'],
    queryFn: ({ pageParam, signal }) =>
      mediaList(
        props.ws,
        { ...params, limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.assets.some((asset) => asset.status === 'PROCESSING'))
        ? POLL_MS
        : false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: getMediaListQueryKey(props.ws) });
  const uploads = useUploads(props.ws, () => {
    void refresh();
  });

  const assets = library.data?.pages.flatMap((page) => page.assets) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {props.canWrite ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <MediaDropzone onFiles={uploads.add} />
          <UploadProgressList items={uploads.items} onDismiss={uploads.dismiss} />
        </div>
      ) : null}

      <div role="group" aria-label={t('filters.label')} className="flex flex-wrap gap-2">
        {FILTERS.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={filter === option ? 'default' : 'outline'}
            aria-pressed={filter === option}
            onClick={() => {
              setFilter(option);
            }}
          >
            {t(`filters.${option}`)}
          </Button>
        ))}
      </div>

      {library.isPending ? (
        <LoadingState label={t('loading')} rows={2} />
      ) : library.isError ? (
        <ErrorState
          title={tStates('error')}
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void library.refetch();
              }}
            >
              {t('loadMore')}
            </Button>
          }
        />
      ) : assets.length === 0 ? (
        filter === 'all' ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : (
          <p className="text-sm text-muted-foreground">{t('emptyFilter')}</p>
        )
      ) : (
        <>
          <ul className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4')}>
            {assets.map((asset) => (
              <li key={asset.id}>
                <MediaCard
                  ws={props.ws}
                  asset={asset}
                  canWrite={props.canWrite}
                  canUseAi={props.canUseAi}
                  onChanged={refresh}
                />
              </li>
            ))}
          </ul>
          {library.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                loading={library.isFetchingNextPage}
                onClick={() => {
                  void library.fetchNextPage();
                }}
              >
                {t('loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
