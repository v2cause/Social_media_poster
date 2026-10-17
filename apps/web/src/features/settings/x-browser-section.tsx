'use client';

import {
  getXBrowserStatusQueryKey,
  useXBrowserDisable,
  useXBrowserEnable,
  useXBrowserStatus,
} from '@smp/api-client';
import { X_BROWSER_RISK, type Locale, type XBrowserStatusDto } from '@smp/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  ErrorState,
  FormField,
  Input,
  Label,
  LoadingState,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';

import { riskBlocksOf, viewOf } from './x-browser-model';

// The section "X ohne API (experimentell)" of the settings (guide step 6.1): the risk text of the
// current version, the checkbox and the password again for owners and admins, and switching off.
// The status explains what keeps the X browser closed when the workspace cannot lift it.

export function XBrowserSection(props: { ws: string; canEnable: boolean }) {
  const t = useTranslations('settings.xBrowser');
  const states = useTranslations('states');
  const actions = useTranslations('actions');
  const status = useXBrowserStatus(props.ws);
  const headingId = useId();

  return (
    <Card role="region" aria-labelledby={headingId}>
      <CardHeader>
        <CardTitle id={headingId} className="flex flex-wrap items-center gap-2">
          {t('title')}
          {status.data ? <StatusBadge status={status.data} /> : null}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status.isPending ? (
          <LoadingState label={states('loading')} />
        ) : status.isError ? (
          <ErrorState
            title={states('error')}
            action={
              <Button type="button" variant="outline" onClick={() => void status.refetch()}>
                {actions('retry')}
              </Button>
            }
          />
        ) : (
          <SectionBody ws={props.ws} canEnable={props.canEnable} status={status.data} />
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: XBrowserStatusDto }) {
  const t = useTranslations('settings.xBrowser.badge');
  if (status.available) {
    return <Badge variant="success">{t('on')}</Badge>;
  }
  return status.enabled ? (
    <Badge variant="warning">{t('blocked')}</Badge>
  ) : (
    <Badge variant="muted">{t('off')}</Badge>
  );
}

function SectionBody(props: { ws: string; canEnable: boolean; status: XBrowserStatusDto }) {
  const t = useTranslations('settings.xBrowser');
  const format = useFormatter();
  const view = viewOf(props.status);
  const { acknowledgement } = props.status;
  const acknowledged = acknowledgement
    ? acknowledgement.acceptedBy
      ? t('enabledBy', {
          date: format.dateTime(new Date(acknowledgement.acceptedAt), { dateStyle: 'medium' }),
          name: acknowledgement.acceptedBy.name,
        })
      : t('enabledAt', {
          date: format.dateTime(new Date(acknowledgement.acceptedAt), { dateStyle: 'medium' }),
        })
    : null;

  return (
    <>
      {view.kind === 'unavailable' ? (
        <Alert variant="info" title={t(`unavailable.${view.reason}`)} />
      ) : view.kind === 'enabled' ? (
        <Alert variant="success" title={t('enabled')}>
          {acknowledged}
        </Alert>
      ) : view.kind === 'renew' ? (
        <Alert variant="destructive" title={t('renew')} />
      ) : null}

      {!props.canEnable ? (
        <p className="text-sm text-muted-foreground">{t('managersOnly')}</p>
      ) : view.kind === 'off' || view.kind === 'renew' ? (
        <EnableForm
          ws={props.ws}
          renew={view.kind === 'renew'}
          currentVersion={props.status.currentVersion}
        />
      ) : null}

      {props.canEnable && props.status.enabled ? <DisableButton ws={props.ws} /> : null}
    </>
  );
}

function RiskText({ locale }: { locale: Locale }) {
  const t = useTranslations('settings.xBrowser');
  const format = useFormatter();
  const blocks = riskBlocksOf(X_BROWSER_RISK.texts[locale]);
  const version = new Date(`${X_BROWSER_RISK.version}T12:00:00Z`);
  return (
    <section
      aria-label={t('riskTitle')}
      className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4 text-sm"
    >
      <h3 className="font-medium">
        {t('riskTitle')}{' '}
        <span className="font-normal text-muted-foreground">
          {t('version', { date: format.dateTime(version, { dateStyle: 'long', timeZone: 'UTC' }) })}
        </span>
      </h3>
      {blocks.map((block, index) =>
        block.kind === 'paragraph' ? (
          <p key={index}>{block.text}</p>
        ) : (
          <ul key={index} className="flex list-disc flex-col gap-2 pl-5">
            {block.items.map((item) => (
              <li key={item.term ?? item.text}>
                {item.term ? <strong>{item.term}: </strong> : null}
                {item.text}
              </li>
            ))}
          </ul>
        ),
      )}
    </section>
  );
}

function EnableForm(props: { ws: string; renew: boolean; currentVersion: string }) {
  const t = useTranslations('settings.xBrowser');
  const locale = useLocale() === 'en' ? 'en' : 'de';
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const checkboxId = useId();
  const [accepted, setAccepted] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const enable = useXBrowserEnable({
    mutation: {
      onSuccess: async (status) => {
        setPassword('');
        setAccepted(false);
        setError(undefined);
        queryClient.setQueryData(getXBrowserStatusQueryKey(props.ws), status);
        toast.success(t('enabledToast'));
        await queryClient.invalidateQueries({ queryKey: getXBrowserStatusQueryKey(props.ws) });
      },
      onError: (failure) => {
        setError(errorMessage(failure));
      },
    },
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!accepted || password === '') {
          return;
        }
        enable.mutate({
          ws: props.ws,
          data: { version: props.currentVersion, locale, accepted: true, password },
        });
      }}
    >
      <RiskText locale={locale} />
      <div className="flex items-start gap-2">
        <Checkbox
          id={checkboxId}
          checked={accepted}
          onChange={(event) => {
            setAccepted(event.target.checked);
          }}
          className="mt-0.5"
        />
        <Label htmlFor={checkboxId} className="leading-5">
          {t('accept')}
        </Label>
      </div>
      <FormField id={`${checkboxId}-password`} label={t('password')} hint={t('passwordHint')} error={error}>
        {(control) => (
          <Input
            {...control}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            className="max-w-sm"
          />
        )}
      </FormField>
      <div>
        <Button type="submit" disabled={!accepted || password === '' || enable.isPending}>
          {props.renew ? t('confirmRenew') : t('enable')}
        </Button>
      </div>
    </form>
  );
}

function DisableButton(props: { ws: string }) {
  const t = useTranslations('settings.xBrowser');
  const actions = useTranslations('actions');
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const disable = useXBrowserDisable({
    mutation: {
      onSuccess: async (status) => {
        setOpen(false);
        queryClient.setQueryData(getXBrowserStatusQueryKey(props.ws), status);
        toast.success(t('disabledToast'));
        await queryClient.invalidateQueries({ queryKey: getXBrowserStatusQueryKey(props.ws) });
      },
      onError: (failure) => {
        toast.error(errorMessage(failure));
      },
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('disable')}
        </Button>
      </div>
      <DialogContent closeLabel={actions('close')}>
        <DialogTitle>{t('disableTitle')}</DialogTitle>
        <DialogDescription>{t('disableDescription')}</DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {actions('cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={disable.isPending}
            onClick={() => {
              disable.mutate({ ws: props.ws });
            }}
          >
            {t('disable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
