'use client';

import {
  getPostsListQueryKey,
  getPublishingListQueryKey,
  postsRemove,
  publishingCancel,
  publishingList,
  useAccountsList,
} from '@smp/api-client';
import { VARIANT_STATUSES, type VariantListItemDto } from '@smp/contracts';
import { PLATFORMS } from '@smp/platform-rules';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  LoadingState,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@smp/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, MoreHorizontal, PenSquare, X } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { useFailureReason } from '@/features/publishing/failure-reason';
import { PlatformMark } from '@/features/publishing/platform-mark';
import { CANCELABLE_STATUSES } from '@/features/publishing/statuses';
import { VariantStatusBadge } from '@/features/publishing/variant-status';
import { useErrorMessage } from '@/lib/use-error-message';

import { isInvertedPeriod, listParamsOf, NO_FILTERS, selectionOf, type PostFilters } from './post-filters';

// The post list of guide step 4.11: one row per variant with preview, account, status, plan and
// publication, filters by status, platform, account and planned period, and the bulk actions
// "cancel plan" and "delete". Status changes arrive as live events and refresh the list.

export function PostTable(props: {
  ws: string;
  timeZone: string;
  canWrite: boolean;
  canSchedule: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations('posts');
  const states = useTranslations('states');
  const actions = useTranslations('actions');
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<PostFilters>(NO_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inverted = isInvertedPeriod(filters);
  const params = listParamsOf(filters, props.timeZone);
  const query = useInfiniteQuery({
    queryKey: [...getPublishingListQueryKey(props.ws, params), 'pages'],
    queryFn: ({ pageParam, signal }) =>
      publishingList(props.ws, pageParam === null ? params : { ...params, cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: !inverted,
  });
  const accounts = useAccountsList(props.ws);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const selection = selectionOf(items, selected);
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  // Only roles with a bulk action select rows.
  const selectable = props.canSchedule || props.canDelete;

  const change = (patch: Partial<PostFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setSelected(new Set());
  };
  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };
  const refresh = async () => {
    setSelected(new Set());
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getPublishingListQueryKey(props.ws) }),
      queryClient.invalidateQueries({ queryKey: getPostsListQueryKey(props.ws) }),
    ]);
  };
  /** Runs one request per target and reports how many worked and the first reason of a failure. */
  const runAll = async <T,>(
    targets: readonly T[],
    request: (target: T) => Promise<unknown>,
    done: (count: number) => string,
  ) => {
    setBusy(true);
    try {
      const results = await Promise.allSettled(targets.map(request));
      const failures = results.filter((result) => result.status === 'rejected');
      const succeeded = results.length - failures.length;
      if (succeeded > 0) {
        toast.success(done(succeeded));
      }
      const [first] = failures;
      if (first) {
        toast.error(t('bulk.failed', { count: failures.length, reason: errorMessage(first.reason) }));
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const cancel = (rows: readonly VariantListItemDto[]) =>
    runAll(
      rows,
      (row) => publishingCancel(props.ws, row.id, { version: row.version }),
      (count) => t('bulk.canceled', { count }),
    );
  const remove = async (postIds: readonly string[]) => {
    await runAll(
      postIds,
      (postId) => postsRemove(props.ws, postId),
      (count) => t('bulk.deleted', { count }),
    );
    setDeleting(null);
  };

  const newPost = props.canWrite ? (
    <Button asChild>
      <Link href={`/w/${props.ws}/compose`}>
        <PenSquare aria-hidden="true" />
        {t('new')}
      </Link>
    </Button>
  ) : null;

  let content;
  if (inverted) {
    content = <EmptyState title={t('filters.invertedPeriod')} />;
  } else if (query.isPending) {
    content = <LoadingState label={states('loading')} />;
  } else if (query.isError) {
    content = (
      <ErrorState
        title={states('error')}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void query.refetch();
            }}
          >
            {actions('retry')}
          </Button>
        }
      />
    );
  } else if (items.length === 0) {
    content = filtered ? (
      <EmptyState title={t('filters.noMatch')} />
    ) : (
      <EmptyState title={t('empty')} description={t('emptyHint')} action={newPost} />
    );
  } else {
    const all = items.every((item) => selected.has(item.id));
    content = (
      <>
        {selectable && selected.size > 0 ? (
          <div
            role="region"
            aria-label={t('bulk.region')}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted p-2"
          >
            <span className="px-2 text-sm font-medium">{t('bulk.selected', { count: selected.size })}</span>
            {props.canSchedule ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || selection.cancelable.length === 0}
                onClick={() => {
                  void cancel(selection.cancelable);
                }}
              >
                {t('bulk.cancel', { count: selection.cancelable.length })}
              </Button>
            ) : null}
            {props.canDelete ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setDeleting(selection.postIds);
                }}
              >
                {t('bulk.delete', { count: selection.postIds.length })}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setSelected(new Set());
              }}
            >
              <X aria-hidden="true" />
              {t('bulk.clear')}
            </Button>
          </div>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              {selectable ? (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label={t('selectAll')}
                    checked={all}
                    onChange={(event) => {
                      setSelected(event.target.checked ? new Set(items.map((item) => item.id)) : new Set());
                    }}
                  />
                </TableHead>
              ) : null}
              <TableHead>{t('columns.preview')}</TableHead>
              <TableHead>{t('columns.account')}</TableHead>
              <TableHead>{t('columns.status')}</TableHead>
              <TableHead>{t('columns.scheduledAt')}</TableHead>
              <TableHead>{t('columns.publishedAt')}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t('columns.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <PostRow
                key={item.id}
                ws={props.ws}
                item={item}
                selected={selected.has(item.id)}
                onSelect={
                  selectable
                    ? (checked) => {
                        toggle(item.id, checked);
                      }
                    : null
                }
                canSchedule={props.canSchedule}
                canDelete={props.canDelete}
                busy={busy}
                onCancel={() => {
                  void cancel([item]);
                }}
                onDelete={() => {
                  setDeleting([item.postId]);
                }}
              />
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
            {t('more')}
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        {items.length > 0 || filtered ? newPost : null}
      </div>
      <fieldset className="grid grid-cols-2 gap-3 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end">
        <legend className="sr-only">{t('filters.title')}</legend>
        <FormField id="filter-status" label={t('filters.status')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={filters.status}
              onChange={(event) => {
                change({ status: event.target.value });
              }}
            >
              <option value="">{t('filters.allStatuses')}</option>
              {VARIANT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`status.${status}`)}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <FormField id="filter-platform" label={t('filters.platform')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={filters.platform}
              onChange={(event) => {
                change({ platform: event.target.value });
              }}
            >
              <option value="">{t('filters.allPlatforms')}</option>
              {PLATFORMS.map((platform) => (
                <PlatformOption key={platform} platform={platform} />
              ))}
            </NativeSelect>
          )}
        </FormField>
        <FormField id="filter-account" label={t('filters.account')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={filters.accountId}
              onChange={(event) => {
                change({ accountId: event.target.value });
              }}
            >
              <option value="">{t('filters.allAccounts')}</option>
              {(accounts.data?.items ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <FormField id="filter-from" label={t('filters.from')}>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={filters.from}
              onChange={(event) => {
                change({ from: event.target.value });
              }}
            />
          )}
        </FormField>
        <FormField
          id="filter-to"
          label={t('filters.to')}
          error={inverted ? t('filters.invertedPeriod') : undefined}
        >
          {(control) => (
            <Input
              {...control}
              type="date"
              value={filters.to}
              onChange={(event) => {
                change({ to: event.target.value });
              }}
            />
          )}
        </FormField>
        <Button
          type="button"
          variant="ghost"
          disabled={!filtered}
          onClick={() => {
            change(NO_FILTERS);
          }}
        >
          {t('filters.reset')}
        </Button>
      </fieldset>
      {content}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
      >
        <DialogContent closeLabel={actions('close')}>
          <DialogTitle>{t('delete.title', { count: deleting?.length ?? 0 })}</DialogTitle>
          <DialogDescription>{t('delete.description')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {actions('cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (deleting) {
                  void remove(deleting);
                }
              }}
            >
              {t('delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PlatformOption(props: { platform: (typeof PLATFORMS)[number] }) {
  const t = useTranslations('platforms');
  return <option value={props.platform}>{t(props.platform)}</option>;
}

function PostRow(props: {
  ws: string;
  item: VariantListItemDto;
  selected: boolean;
  /** Null for roles without a bulk action. */
  onSelect: ((checked: boolean) => void) | null;
  canSchedule: boolean;
  canDelete: boolean;
  busy: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { item } = props;
  const t = useTranslations('posts');
  const failureReason = useFailureReason();
  const format = useFormatter();
  const preview = item.preview === '' ? t('noText') : item.preview;
  const href = `/w/${props.ws}/posts/${item.postId}`;
  const cancelable = props.canSchedule && CANCELABLE_STATUSES.includes(item.status);
  const reason = item.failureCode === null ? null : failureReason(item.failureCode);

  return (
    <TableRow>
      {props.onSelect ? (
        <TableCell>
          <Checkbox
            aria-label={t('selectRow', { preview })}
            checked={props.selected}
            onChange={(event) => {
              props.onSelect?.(event.target.checked);
            }}
          />
        </TableCell>
      ) : null}
      <TableCell className="min-w-64 max-w-md">
        <div className="flex items-start gap-2">
          <PlatformMark platform={item.platform} className="mt-0.5" />
          <div className="min-w-0">
            <Link
              href={href}
              className="line-clamp-2 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {preview}
            </Link>
            {reason ? <p className="text-xs text-destructive">{reason}</p> : null}
          </div>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {item.account ? item.account.name : <span className="text-muted-foreground">{t('noAccount')}</span>}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          <VariantStatusBadge status={item.status} />
          {item.isDryRun ? <Badge variant="muted">{t('dryRun')}</Badge> : null}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {item.scheduledAt
          ? format.dateTime(new Date(item.scheduledAt), {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              timeZoneName: 'short',
              ...(item.scheduledTimezone ? { timeZone: item.scheduledTimezone } : {}),
            })
          : null}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {item.publishedAt ? (
          <div className="flex flex-col">
            <span className="text-muted-foreground">
              {format.dateTime(new Date(item.publishedAt), { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
            {item.externalUrl ? (
              <a
                href={item.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs hover:underline"
              >
                <ExternalLink className="size-3" aria-hidden="true" />
                {t('original')}
              </a>
            ) : null}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={t('rowActions.menu', { preview })}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={href}>{t('rowActions.open')}</Link>
            </DropdownMenuItem>
            {item.externalUrl ? (
              <DropdownMenuItem asChild>
                <a href={item.externalUrl} target="_blank" rel="noopener noreferrer">
                  {t('original')}
                </a>
              </DropdownMenuItem>
            ) : null}
            {cancelable ? (
              <DropdownMenuItem disabled={props.busy} onSelect={props.onCancel}>
                {t('rowActions.cancel')}
              </DropdownMenuItem>
            ) : null}
            {props.canDelete ? (
              <DropdownMenuItem disabled={props.busy} onSelect={props.onDelete}>
                {t('rowActions.delete')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
