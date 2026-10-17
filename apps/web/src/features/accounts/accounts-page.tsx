'use client';

import {
  getAccountsListQueryKey,
  useAccountsDisconnect,
  useAccountsList,
  useAccountsReconnect,
  useChannelsConnect,
  useChannelsList,
} from '@smp/api-client';
import { slugOfPlatform, type ConnectFailure, type SocialAccountDto } from '@smp/contracts';
import { PLATFORMS, type Platform } from '@smp/platform-rules';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Unlink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PlatformMark } from '@/features/publishing/platform-mark';
import { useErrorMessage } from '@/lib/use-error-message';

import { accessExpiryOf, initialsOf, STATUS_BADGE, usdOf } from './account-model';

// The accounts of a workspace (guide step 4.11): a card per platform to connect it, and the
// connected accounts with the state of their access, the costs of X and, for owners and admins,
// reconnect and disconnect. The OAuth callback comes back here with ?connect_error=<code>, the
// selection page with ?connected=<count>.

export function AccountsPage(props: {
  ws: string;
  canManage: boolean;
  connectError: ConnectFailure | 'other' | null;
  connected: number | null;
}) {
  const t = useTranslations('accounts');
  const states = useTranslations('states');
  const actions = useTranslations('actions');
  const router = useRouter();
  const [connectError] = useState(props.connectError);

  // The result of the round trip is shown once; a reload does not repeat it.
  useEffect(() => {
    if (props.connected !== null) {
      toast.success(t('connected', { count: props.connected }));
    }
    if (props.connectError !== null || props.connected !== null) {
      router.replace(`/w/${props.ws}/accounts`, { scroll: false });
    }
  }, [props.connectError, props.connected, props.ws, router, t]);

  const accounts = useAccountsList(props.ws);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>
      {connectError ? (
        <Alert variant="destructive" title={t('connectError.title')}>
          {t(`connectError.${connectError}`)}
        </Alert>
      ) : null}
      {props.canManage ? <PlatformCards ws={props.ws} /> : null}
      <section aria-labelledby="connected-accounts" className="flex flex-col gap-4">
        <div>
          <h2 id="connected-accounts" className="text-lg font-semibold">
            {t('list.title')}
          </h2>
          {props.canManage ? null : (
            <p className="text-sm text-muted-foreground">{t('platforms.managersOnly')}</p>
          )}
        </div>
        {accounts.isPending ? (
          <LoadingState label={states('loading')} />
        ) : accounts.isError ? (
          <ErrorState
            title={states('error')}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void accounts.refetch();
                }}
              >
                {actions('retry')}
              </Button>
            }
          />
        ) : accounts.data.items.length === 0 ? (
          <EmptyState title={t('list.empty')} description={t('list.emptyHint')} />
        ) : (
          <ul className="flex flex-col gap-3">
            {accounts.data.items.map((account) => (
              <li key={account.id}>
                <AccountRow ws={props.ws} account={account} canManage={props.canManage} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PlatformCards(props: { ws: string }) {
  const t = useTranslations('accounts.platforms');
  const platforms = useTranslations('platforms');
  const errorMessage = useErrorMessage();
  const options = useChannelsList(props.ws);
  const [redirecting, setRedirecting] = useState<Platform | null>(null);
  const connect = useChannelsConnect({
    mutation: {
      onSuccess: ({ authorizationUrl }) => {
        window.location.assign(authorizationUrl);
      },
      onError: (error) => {
        setRedirecting(null);
        toast.error(errorMessage(error));
      },
    },
  });
  const methodOf = (platform: Platform) =>
    options.data?.items.find((option) => option.platform === platform)?.method ?? null;

  return (
    <section aria-labelledby="connect-platform" className="flex flex-col gap-4">
      <h2 id="connect-platform" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {PLATFORMS.map((platform) => {
          const method = methodOf(platform);
          return (
            <li key={platform}>
              <Card className="h-full">
                <CardContent className="flex h-full flex-col gap-4 pt-6">
                  <div className="flex items-start gap-3">
                    <PlatformMark platform={platform} size="md" />
                    <div className="min-w-0">
                      <p className="font-medium">{platforms(platform)}</p>
                      <p className="text-sm text-muted-foreground">{t(`hints.${platform}`)}</p>
                    </div>
                  </div>
                  {platform === 'X' && method !== null ? (
                    <fieldset className="flex flex-col gap-2 text-sm">
                      <legend className="mb-1 font-medium">{t('method.label')}</legend>
                      <label className="flex items-center gap-2">
                        <input type="radio" name="x-method" checked readOnly className="accent-primary" />
                        {t(`method.${method === 'MOCK' ? 'MOCK' : 'API'}`)}
                      </label>
                      <label className="flex items-start gap-2 text-muted-foreground">
                        <input type="radio" name="x-method" disabled className="mt-0.5" />
                        <span>
                          {t('method.BROWSER')}
                          <span className="block text-xs">{t('method.browserLater')}</span>
                        </span>
                      </label>
                    </fieldset>
                  ) : null}
                  <div className="mt-auto">
                    {options.isPending ? null : method === null ? (
                      <Badge variant="muted">{t('unavailable')}</Badge>
                    ) : (
                      <Button
                        type="button"
                        className="w-full"
                        disabled={redirecting !== null}
                        onClick={() => {
                          setRedirecting(platform);
                          connect.mutate({ ws: props.ws, platform: slugOfPlatform(platform) });
                        }}
                      >
                        {redirecting === platform
                          ? t('redirecting')
                          : t('connect', { platform: platforms(platform) })}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AccountRow(props: { ws: string; account: SocialAccountDto; canManage: boolean }) {
  const { account } = props;
  const t = useTranslations('accounts');
  const actions = useTranslations('actions');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const reconnect = useAccountsReconnect({
    mutation: {
      onSuccess: ({ authorizationUrl }) => {
        window.location.assign(authorizationUrl);
      },
      onError: (error) => {
        toast.error(errorMessage(error));
      },
    },
  });
  const disconnect = useAccountsDisconnect({
    mutation: {
      onSuccess: async () => {
        setConfirming(false);
        toast.success(t('disconnect.done', { name: account.name }));
        await queryClient.invalidateQueries({ queryKey: getAccountsListQueryKey(props.ws) });
      },
      onError: (error) => {
        toast.error(errorMessage(error));
      },
    },
  });
  const expiry = accessExpiryOf(account.accessExpiresAt, now);
  const attention = account.status === 'NEEDS_REAUTH' || account.status === 'EXPIRING';

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            role="img"
            aria-label={t('list.avatar', { name: account.name })}
            className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold"
          >
            {initialsOf(account.name)}
            <PlatformMark
              platform={account.platform}
              size="xs"
              className="absolute -bottom-0.5 -right-0.5 ring-2 ring-background"
            />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="truncate font-medium">
              {account.name}
              {account.handle ? (
                <span className="ml-2 font-normal text-muted-foreground">@{account.handle}</span>
              ) : null}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="muted">{t(`list.type.${account.type}`)}</Badge>
              <Badge variant={STATUS_BADGE[account.status]}>{t(`list.status.${account.status}`)}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {expiry.kind === 'date'
                ? t('list.expiry.date', { date: format.dateTime(expiry.date, { dateStyle: 'medium' }) })
                : expiry.kind === 'days'
                  ? t('list.expiry.days', { days: expiry.days })
                  : t(`list.expiry.${expiry.kind}`)}
              {' · '}
              {t('list.connectedAt', {
                date: format.dateTime(new Date(account.connectedAt), { dateStyle: 'medium' }),
              })}
            </p>
            {account.missingScopes.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('list.missingScopes', { scopes: account.missingScopes.join(', ') })}
              </p>
            ) : null}
            {account.costMicros !== null ? (
              <p className="text-sm">
                {t('list.cost', {
                  amount: format.number(usdOf(account.costMicros), {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 4,
                  }),
                })}
              </p>
            ) : null}
          </div>
        </div>
        {props.canManage ? (
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant={attention ? 'default' : 'outline'}
              size="sm"
              disabled={reconnect.isPending}
              onClick={() => {
                reconnect.mutate({ ws: props.ws, accountId: account.id });
              }}
            >
              <RefreshCw aria-hidden="true" />
              {t('list.reconnect')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirming(true);
              }}
            >
              <Unlink aria-hidden="true" />
              {t('list.disconnect')}
            </Button>
          </div>
        ) : null}
      </CardContent>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent closeLabel={actions('close')}>
          <DialogTitle>{t('disconnect.title', { name: account.name })}</DialogTitle>
          <DialogDescription>{t('disconnect.description')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {actions('cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={() => {
                disconnect.mutate({ ws: props.ws, accountId: account.id });
              }}
            >
              {t('disconnect.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
