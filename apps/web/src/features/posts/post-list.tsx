'use client';

import { getPostsListQueryKey, postsList } from '@smp/api-client';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@smp/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { PenSquare } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

// The drafts and posts of a workspace, most recently changed first (guide step 2.8). Each row
// opens the post in the composer; "Load more" follows the cursor of the API.

const EXCERPT_LENGTH = 140;

const excerpt = (text: string): string =>
  text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH).trimEnd()} ...` : text;

export function PostList(props: { ws: string; canWrite: boolean }) {
  const t = useTranslations();
  const format = useFormatter();
  const query = useInfiniteQuery({
    queryKey: [...getPostsListQueryKey(props.ws), 'pages'],
    queryFn: ({ pageParam, signal }) =>
      postsList(props.ws, pageParam === null ? undefined : { cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
  const posts = query.data?.pages.flatMap((page) => page.posts) ?? [];
  const newPost = props.canWrite ? (
    <Button asChild>
      <Link href={`/w/${props.ws}/compose`}>
        <PenSquare aria-hidden="true" />
        {t('posts.new')}
      </Link>
    </Button>
  ) : null;

  let content;
  if (query.isPending) {
    content = <LoadingState label={t('states.loading')} />;
  } else if (query.isError) {
    content = (
      <ErrorState
        title={t('states.error')}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('actions.retry')}
          </Button>
        }
      />
    );
  } else if (posts.length === 0) {
    content = <EmptyState title={t('posts.empty')} description={t('posts.emptyHint')} action={newPost} />;
  } else {
    content = (
      <>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('posts.brief')}</TableHead>
              <TableHead>{t('posts.platforms')}</TableHead>
              <TableHead>{t('posts.updated')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {posts.map((post) => (
              <TableRow key={post.id}>
                <TableCell className="max-w-md">
                  <Link
                    href={`/w/${props.ws}/posts/${post.id}`}
                    className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {post.brief.trim() === '' ? t('posts.noBrief') : excerpt(post.brief)}
                  </Link>
                </TableCell>
                <TableCell>
                  <ul className="flex flex-wrap gap-1">
                    {post.variants.map((variant) => (
                      <li key={variant.id}>
                        <Badge variant="muted">
                          {t(`platforms.${variant.platform}`)}: {t(`posts.status.${variant.status}`)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {format.dateTime(new Date(post.updatedAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {query.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            className="self-center"
            disabled={query.isFetchingNextPage}
            onClick={() => {
              void query.fetchNextPage();
            }}
          >
            {t('posts.more')}
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('posts.title')}</h1>
          <p className="text-muted-foreground">{t('posts.description')}</p>
        </div>
        {posts.length > 0 ? newPost : null}
      </div>
      {content}
    </div>
  );
}
