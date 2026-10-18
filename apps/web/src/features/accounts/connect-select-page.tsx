'use client';

import { getAccountsListQueryKey, useChannelsConfirm, useChannelsPending } from '@smp/api-client';
import type { PendingConnectionDto } from '@smp/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  LoadingState,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { PlatformMark } from '@/features/publishing/platform-mark';
import { useErrorMessage } from '@/lib/use-error-message';

import { initialsOf, preselectedAccounts } from './account-model';

// The selection after the consent (guide steps 4.5 and 4.11): one checkbox per account the
// consent reaches. The consent waits 15 minutes; a stale or foreign id shows the way back.

export function ConnectSelectPage(props: { ws: string; pendingId: string | null }) {
  const t = useTranslations('accounts');
  const states = useTranslations('states');
  const back = (
    <Button asChild variant="outline">
      <Link href={`/w/${props.ws}/accounts`}>{t('select.back')}</Link>
    </Button>
  );
  const pending = useChannelsPending(props.ws, props.pendingId ?? '', {
    query: { enabled: props.pendingId !== null, retry: false, refetchOnWindowFocus: false },
  });

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('select.title')}</h1>
      {props.pendingId === null || pending.isError ? (
        <EmptyState title={t('select.expired')} action={back} />
      ) : pending.isPending ? (
        <LoadingState label={states('loading')} />
      ) : (
        <SelectionForm ws={props.ws} pending={pending.data} back={back} />
      )}
    </div>
  );
}

function SelectionForm(props: { ws: string; pending: PendingConnectionDto; back: ReactNode }) {
  const { pending } = props;
  const t = useTranslations('accounts');
  const platforms = useTranslations('platforms');
  const format = useFormatter();
  const router = useRouter();
  const queryClient = useQueryClient();
  const errorMessage = useErrorMessage();
  const [selected, setSelected] = useState(() => preselectedAccounts(pending));
  const [tried, setTried] = useState(false);
  const confirm = useChannelsConfirm({
    mutation: {
      onSuccess: async ({ accountIds }) => {
        await queryClient.invalidateQueries({ queryKey: getAccountsListQueryKey(props.ws) });
        router.push(`/w/${props.ws}/accounts?connected=${String(accountIds.length)}`);
      },
      onError: (error) => {
        toast.error(errorMessage(error));
      },
    },
  });

  if (pending.accounts.length === 0) {
    return <EmptyState title={t('select.empty')} action={props.back} />;
  }
  const toggle = (externalId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(externalId);
      } else {
        next.delete(externalId);
      }
      return next;
    });
  };

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (selected.size > 0) {
          confirm.mutate({ ws: props.ws, pendingId: pending.id, data: { externalIds: [...selected] } });
        }
      }}
    >
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <PlatformMark platform={pending.platform} size="md" />
            <CardTitle>{platforms(pending.platform)}</CardTitle>
          </div>
          <CardDescription>
            {t('select.description', { name: pending.displayName, platform: platforms(pending.platform) })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {pending.missingScopes.length > 0 ? (
            <Alert title={t('select.missingScopes', { scopes: pending.missingScopes.join(', ') })} />
          ) : null}
          <fieldset className="flex flex-col gap-2" aria-describedby={tried ? 'selection-error' : undefined}>
            <legend className="mb-2 text-sm font-medium">{t('select.accounts')}</legend>
            {pending.accounts.map((account) => {
              const id = `account-${account.externalId}`;
              return (
                <label
                  key={account.externalId}
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3 hover:bg-muted"
                >
                  <Checkbox
                    id={id}
                    checked={selected.has(account.externalId)}
                    onChange={(event) => {
                      toggle(account.externalId, event.target.checked);
                    }}
                  />
                  <span
                    aria-hidden="true"
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold"
                  >
                    {initialsOf(account.name)}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {account.name}
                      {account.handle ? (
                        <span className="ml-2 font-normal text-muted-foreground">@{account.handle}</span>
                      ) : null}
                    </span>
                    {account.connected ? (
                      <span className="text-xs text-muted-foreground">{t('select.connected')}</span>
                    ) : null}
                  </span>
                  <Badge variant="muted" className="ml-auto">
                    {t(`list.type.${account.type}`)}
                  </Badge>
                </label>
              );
            })}
            {tried && selected.size === 0 ? (
              <p id="selection-error" className="text-sm text-destructive">
                {t('select.none')}
              </p>
            ) : null}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            {t('select.validUntil', {
              time: format.dateTime(new Date(pending.expiresAt), { timeStyle: 'short' }),
            })}
          </p>
        </CardContent>
        <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {props.back}
          <Button type="submit" disabled={confirm.isPending}>
            {t('select.confirm')}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
