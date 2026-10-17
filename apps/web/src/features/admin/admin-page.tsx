'use client';

import {
  ApiError,
  getXBrowserAdminGetQueryKey,
  useXBrowserAdminAllow,
  useXBrowserAdminDisallow,
  useXBrowserAdminGet,
  useXBrowserAdminSetKillSwitch,
} from '@smp/api-client';
import type { XBrowserAdminDto } from '@smp/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  LoadingState,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';

// The page of the platform admins (guide step 6.1): the global kill switch of the X browser and
// the organizations allowed to use it until the plans of phase 7. Everyone else gets no access;
// the API checks the flag isPlatformAdmin on every call.

export function AdminPage() {
  const t = useTranslations('admin');
  const states = useTranslations('states');
  const admin = useXBrowserAdminGet({ query: { retry: false } });

  if (admin.isPending) {
    return <LoadingState label={states('loading')} />;
  }
  if (admin.isError) {
    return admin.error instanceof ApiError && admin.error.status === 403 ? (
      <EmptyState title={t('denied.title')} description={t('denied.description')} />
    ) : (
      <ErrorState title={states('error')} />
    );
  }
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>
      <XBrowserCard view={admin.data} />
    </div>
  );
}

function XBrowserCard({ view }: { view: XBrowserAdminDto }) {
  const t = useTranslations('admin.xBrowser');
  const headingId = useId();
  return (
    <Card role="region" aria-labelledby={headingId}>
      <CardHeader>
        <CardTitle id={headingId}>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {view.offered ? null : <Alert variant="info" title={t('notOffered')} />}
        <KillSwitch view={view} />
        <Organizations view={view} />
      </CardContent>
    </Card>
  );
}

function KillSwitch({ view }: { view: XBrowserAdminDto }) {
  const t = useTranslations('admin.xBrowser');
  const actions = useTranslations('actions');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const { active, updatedAt } = view.killSwitch;
  const setKillSwitch = useXBrowserAdminSetKillSwitch({
    mutation: {
      onSuccess: async (next) => {
        setConfirming(false);
        queryClient.setQueryData(getXBrowserAdminGetQueryKey(), next);
        toast.success(next.killSwitch.active ? t('activatedToast') : t('deactivatedToast'));
        await queryClient.invalidateQueries({ queryKey: getXBrowserAdminGetQueryKey() });
      },
      onError: (error) => {
        toast.error(errorMessage(error));
      },
    },
  });

  return (
    <section className="flex flex-col gap-3" aria-label={t('killSwitch')}>
      <h3 className="flex items-center gap-2 font-medium">
        {t('killSwitch')}
        <Badge variant={active ? 'destructive' : 'muted'}>{active ? t('active') : t('inactive')}</Badge>
      </h3>
      <p className="text-sm text-muted-foreground">
        {active && updatedAt
          ? t('activeSince', {
              date: format.dateTime(new Date(updatedAt), { dateStyle: 'medium', timeStyle: 'short' }),
            })
          : t('inactiveHint')}
      </p>
      <div>
        {active ? (
          <Button
            type="button"
            variant="outline"
            disabled={setKillSwitch.isPending}
            onClick={() => {
              setKillSwitch.mutate({ data: { active: false } });
            }}
          >
            {t('deactivate')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t('activate')}
          </Button>
        )}
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent closeLabel={actions('close')}>
          <DialogTitle>{t('activateTitle')}</DialogTitle>
          <DialogDescription>{t('activateDescription')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {actions('cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={setKillSwitch.isPending}
              onClick={() => {
                setKillSwitch.mutate({ data: { active: true } });
              }}
            >
              {t('activate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Organizations({ view }: { view: XBrowserAdminDto }) {
  const t = useTranslations('admin.xBrowser');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const refresh = () => queryClient.invalidateQueries({ queryKey: getXBrowserAdminGetQueryKey() });
  const allow = useXBrowserAdminAllow({
    mutation: {
      onSuccess: async (organization) => {
        setSlug('');
        setError(undefined);
        toast.success(t('allowedToast', { name: organization.name }));
        await refresh();
      },
      onError: (failure) => {
        setError(errorMessage(failure));
      },
    },
  });
  const disallow = useXBrowserAdminDisallow({
    mutation: {
      onSuccess: async () => {
        toast.success(t('removedToast'));
        await refresh();
      },
      onError: (failure) => {
        toast.error(errorMessage(failure));
      },
    },
  });

  return (
    <section className="flex flex-col gap-3" aria-label={t('organizations')}>
      <h3 className="font-medium">{t('organizations')}</h3>
      <p className="text-sm text-muted-foreground">{t('organizationsHint')}</p>
      {view.organizations.length === 0 ? (
        <p className="text-sm">{t('none')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {view.organizations.map((organization) => (
            <li key={organization.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="font-medium">{organization.name}</span>{' '}
                <span className="text-sm text-muted-foreground">
                  {t('since', {
                    date: format.dateTime(new Date(organization.updatedAt), { dateStyle: 'medium' }),
                  })}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disallow.isPending}
                aria-label={t('removeNamed', { name: organization.name })}
                onClick={() => {
                  disallow.mutate({ organizationId: organization.id });
                }}
              >
                {t('remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (slug.trim() !== '') {
            allow.mutate({ data: { workspaceSlug: slug.trim() } });
          }
        }}
      >
        <div className="min-w-64 flex-1">
          <FormField id={fieldId} label={t('workspaceSlug')} error={error}>
            {(control) => (
              <Input
                {...control}
                value={slug}
                onChange={(event) => {
                  setSlug(event.target.value);
                }}
                autoComplete="off"
              />
            )}
          </FormField>
        </div>
        <Button type="submit" disabled={slug.trim() === '' || allow.isPending}>
          {t('allow')}
        </Button>
      </form>
    </section>
  );
}
