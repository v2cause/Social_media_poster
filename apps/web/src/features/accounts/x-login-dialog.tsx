'use client';

import {
  getAccountsListQueryKey,
  getXBrowserLoginGetQueryKey,
  useXBrowserLoginCode,
  useXBrowserLoginGet,
  useXBrowserLoginStart,
} from '@smp/api-client';
import type { XbLoginSessionDto } from '@smp/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  FormField,
  Input,
  LoadingState,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';

// The login of X without the API (guide step 6.4): user name and password once, the code of the
// two-factor login when X asks for it, and the status of the browser worker as it comes, through
// the live event xb.login and, in case one gets lost, a look every few seconds. The password
// leaves the form with the request and is cleared right after; nothing of it is kept.

const OPEN_STATUSES: readonly XbLoginSessionDto['status'][] = ['STARTING', 'AWAITING_2FA', 'VERIFYING'];
const POLL_MS = 3_000;

/** The account to connect again: the same X user has to sign in. */
export interface XLoginTarget {
  accountId: string;
  handle: string | null;
}

export function XLoginDialog(props: {
  ws: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconnect?: XLoginTarget;
}) {
  const t = useTranslations('accounts.xLogin');
  const actions = useTranslations('actions');
  const [loginId, setLoginId] = useState<string | null>(null);
  const [username, setUsername] = useState(props.reconnect?.handle ?? '');
  // A dialog that opens again starts a new login; a running one goes on without it.
  const onOpenChange = (open: boolean) => {
    if (!open) {
      setLoginId(null);
    }
    props.onOpenChange(open);
  };

  return (
    <Dialog open={props.open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={actions('close')}>
        <DialogTitle>
          {props.reconnect?.handle ? t('reconnectTitle', { handle: props.reconnect.handle }) : t('title')}
        </DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        {loginId === null ? (
          <CredentialsStep
            ws={props.ws}
            username={username}
            onUsernameChange={setUsername}
            reconnectAccountId={props.reconnect?.accountId}
            onStarted={setLoginId}
          />
        ) : (
          <LoginProgress
            ws={props.ws}
            loginId={loginId}
            onRetry={() => {
              setLoginId(null);
            }}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CredentialsStep(props: {
  ws: string;
  username: string;
  onUsernameChange: (username: string) => void;
  reconnectAccountId: string | undefined;
  onStarted: (loginId: string) => void;
}) {
  const t = useTranslations('accounts.xLogin');
  const locale = useLocale() === 'en' ? 'en' : 'de';
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const id = useId();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const start = useXBrowserLoginStart({
    mutation: {
      onSuccess: (login) => {
        setPassword('');
        queryClient.setQueryData(getXBrowserLoginGetQueryKey(props.ws, login.id), login);
        props.onStarted(login.id);
      },
      onError: (failure) => {
        setPassword('');
        setError(errorMessage(failure));
      },
    },
  });
  const ready = props.username.trim() !== '' && password !== '' && !start.isPending;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) {
          return;
        }
        setError(undefined);
        start.mutate({
          ws: props.ws,
          data: {
            username: props.username.trim(),
            password,
            locale,
            ...(props.reconnectAccountId ? { reconnectAccountId: props.reconnectAccountId } : {}),
          },
        });
      }}
    >
      <FormField id={`${id}-username`} label={t('username')} hint={t('usernameHint')}>
        {(control) => (
          <Input
            {...control}
            autoComplete="off"
            spellCheck={false}
            value={props.username}
            onChange={(event) => {
              props.onUsernameChange(event.target.value);
            }}
          />
        )}
      </FormField>
      <FormField id={`${id}-password`} label={t('password')} hint={t('passwordHint')} error={error}>
        {(control) => (
          <Input
            {...control}
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        )}
      </FormField>
      <DialogFooter>
        <Button type="submit" disabled={!ready}>
          {start.isPending ? t('starting') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function LoginProgress(props: { ws: string; loginId: string; onRetry: () => void; onDone: () => void }) {
  const t = useTranslations('accounts.xLogin');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const [codesSent, setCodesSent] = useState(0);
  const login = useXBrowserLoginGet(props.ws, props.loginId, {
    query: {
      refetchInterval: (query) =>
        query.state.data && OPEN_STATUSES.includes(query.state.data.status) ? POLL_MS : false,
    },
  });
  const status = login.data?.status;
  const { onDone } = props;
  // The success is announced once, whatever renders until the dialog closes.
  const announced = useRef(false);

  useEffect(() => {
    if (status === 'SUCCEEDED' && !announced.current) {
      announced.current = true;
      toast.success(t('succeeded'));
      void queryClient.invalidateQueries({ queryKey: getAccountsListQueryKey(props.ws) });
      onDone();
    }
  }, [status, t, queryClient, props.ws, onDone]);

  if (!login.data) {
    return login.isError ? (
      <LoginFailed message={t('lost')} onRetry={props.onRetry} />
    ) : (
      <LoadingState label={t('waiting.STARTING')} />
    );
  }
  const { data } = login;
  if (data.status === 'FAILED') {
    return <LoginFailed message={t(`failure.${data.failure ?? 'TRANSIENT'}`)} onRetry={props.onRetry} />;
  }
  const until = t('until', {
    time: format.dateTime(new Date(data.expiresAt), { timeStyle: 'short' }),
  });
  if (data.status === 'AWAITING_2FA') {
    return (
      <CodeStep
        ws={props.ws}
        loginId={props.loginId}
        retry={codesSent > 0}
        until={until}
        onSent={() => {
          setCodesSent((sent) => sent + 1);
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <LoadingState label={t(`waiting.${data.status === 'VERIFYING' ? 'VERIFYING' : 'STARTING'}`)} />
      <p className="text-center text-sm text-muted-foreground">{until}</p>
    </div>
  );
}

function CodeStep(props: { ws: string; loginId: string; retry: boolean; until: string; onSent: () => void }) {
  const t = useTranslations('accounts.xLogin');
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const id = useId();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = useXBrowserLoginCode({
    mutation: {
      onSuccess: (login) => {
        setCode('');
        queryClient.setQueryData(getXBrowserLoginGetQueryKey(props.ws, props.loginId), login);
        props.onSent();
      },
      onError: (failure) => {
        setError(errorMessage(failure));
      },
    },
  });
  const ready = /^[A-Za-z0-9]{6,12}$/.test(code.trim()) && !submit.isPending;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) {
          return;
        }
        setError(undefined);
        submit.mutate({ ws: props.ws, loginId: props.loginId, data: { code: code.trim() } });
      }}
    >
      <div role="status">
        {props.retry ? (
          <Alert variant="destructive" title={t('codeRejected')} />
        ) : (
          <Alert variant="info" title={t('codeRequested')} />
        )}
      </div>
      <FormField id={`${id}-code`} label={t('code')} hint={t('codeHint')} error={error}>
        {(control) => (
          <Input
            {...control}
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={12}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
            className="max-w-48"
          />
        )}
      </FormField>
      <p className="text-sm text-muted-foreground">{props.until}</p>
      <DialogFooter>
        <Button type="submit" disabled={!ready}>
          {t('sendCode')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function LoginFailed(props: { message: string; onRetry: () => void }) {
  const t = useTranslations('accounts.xLogin');
  return (
    <div className="flex flex-col gap-4" role="status">
      <Alert variant="destructive" title={t('failed')}>
        {props.message}
      </Alert>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onRetry}>
          {t('retry')}
        </Button>
      </DialogFooter>
    </div>
  );
}
