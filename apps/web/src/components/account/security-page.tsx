'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { getMeGetQueryKey, useMeGet } from '@smp/api-client';
import {
  changePasswordSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type ChangePasswordRequest,
} from '@smp/contracts';
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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Label,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@smp/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import QRCode from 'react-qr-code';
import { toast } from 'sonner';

import { useAuthError } from '@/components/auth/auth-error';
import { authClient } from '@/lib/auth-client';
import { useFieldError } from '@/lib/use-field-error';
import { useSignOut } from '@/lib/use-sign-out';

/** Password, two-factor setup and signed-in devices (guide steps 1.9 and 8.4). */
export function SecurityPage({ twoFactorRequired = false }: { twoFactorRequired?: boolean }) {
  const t = useTranslations('account');
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('security.title')}</h1>
        <p className="text-muted-foreground">{t('security.description')}</p>
      </div>
      {twoFactorRequired ? (
        <Alert title={t('security.required.title')}>{t('security.required.description')}</Alert>
      ) : null}
      <PasswordCard />
      <TwoFactorCard />
      <SessionsCard />
    </div>
  );
}

/**
 * The change of the password (ASVS 6.2.2 and 6.2.3): the current one and a new one, which the API
 * checks against the password policy. Signing out the other devices is the default (ASVS 7.4.3).
 */
function PasswordCard() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const fieldError = useFieldError();
  const authError = useAuthError();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<ChangePasswordRequest>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { current: '', password: '', confirm: '', signOutOthers: true },
  });

  const submit = form.handleSubmit(async ({ current, password, signOutOthers }) => {
    setError(null);
    const result = await authClient.changePassword({
      currentPassword: current,
      newPassword: password,
      revokeOtherSessions: signOutOthers,
    });
    if (result.error) {
      setError(authError(result.error));
      return;
    }
    form.reset();
    toast.success(t('account.password.changed'));
    await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('account.password.title')}</CardTitle>
        <CardDescription>{t('account.password.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          {error ? <Alert variant="destructive" title={error} /> : null}
          <FormField
            id="password-current"
            label={t('account.password.current')}
            error={fieldError(form.formState.errors.current)}
          >
            {(control) => (
              <Input
                {...control}
                {...form.register('current')}
                type="password"
                autoComplete="current-password"
              />
            )}
          </FormField>
          <FormField
            id="password-new"
            label={t('auth.fields.newPassword')}
            hint={t('auth.passwordHint', { min: PASSWORD_MIN_LENGTH })}
            error={fieldError(form.formState.errors.password, {
              minimum: PASSWORD_MIN_LENGTH,
              maximum: PASSWORD_MAX_LENGTH,
            })}
          >
            {(control) => (
              <Input
                {...control}
                {...form.register('password')}
                type="password"
                autoComplete="new-password"
              />
            )}
          </FormField>
          <FormField
            id="password-confirm"
            label={t('auth.fields.confirmPassword')}
            error={fieldError(form.formState.errors.confirm)}
          >
            {(control) => (
              <Input {...control} {...form.register('confirm')} type="password" autoComplete="new-password" />
            )}
          </FormField>
          <div className="flex items-center gap-2">
            <Checkbox id="password-sign-out-others" {...form.register('signOutOthers')} />
            <Label htmlFor="password-sign-out-others">{t('account.password.signOutOthers')}</Label>
          </div>
          <Button type="submit" className="self-start" loading={form.formState.isSubmitting}>
            {t('account.password.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

type Setup =
  | { phase: 'password'; mode: 'enable' | 'disable' }
  | { phase: 'scan'; totpURI: string; backupCodes: string[] };

function TwoFactorCard() {
  const t = useTranslations();
  const authError = useAuthError();
  const queryClient = useQueryClient();
  const me = useMeGet();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setSetup(null);
    setPassword('');
    setCode('');
    setError(null);
  };

  const refreshMe = () => queryClient.invalidateQueries({ queryKey: getMeGetQueryKey() });

  const confirmPassword = async () => {
    if (setup?.phase !== 'password') {
      return;
    }
    setBusy(true);
    setError(null);
    if (setup.mode === 'enable') {
      const result = await authClient.twoFactor.enable({ password });
      if (result.error) {
        setError(authError(result.error));
      } else if (result.data.method === 'totp') {
        setSetup({ phase: 'scan', totpURI: result.data.totpURI, backupCodes: result.data.backupCodes });
      }
    } else {
      const result = await authClient.twoFactor.disable({ password });
      if (result.error) {
        setError(authError(result.error));
      } else {
        toast.success(t('account.twoFactor.disabledToast'));
        close();
        await refreshMe();
      }
    }
    setBusy(false);
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.verifyTotp({ code: code.trim() });
    setBusy(false);
    if (result.error) {
      setError(authError(result.error));
      return;
    }
    toast.success(t('account.twoFactor.enabledToast'));
    close();
    await refreshMe();
  };

  const downloadCodes = (codes: string[]) => {
    const url = URL.createObjectURL(new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = t('account.twoFactor.backupFileName');
    link.click();
    URL.revokeObjectURL(url);
  };

  const enabled = me.data?.twoFactorEnabled === true;
  const secret = setup?.phase === 'scan' ? (new URL(setup.totpURI).searchParams.get('secret') ?? '') : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('account.twoFactor.title')}
          {me.data ? (
            <Badge variant={enabled ? 'default' : 'muted'}>
              {enabled ? t('account.twoFactor.statusOn') : t('account.twoFactor.statusOff')}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          {me.isPending
            ? t('states.loading')
            : enabled
              ? t('account.twoFactor.enabled')
              : t('account.twoFactor.disabled')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {me.isError ? (
          <ErrorState title={t('states.error')} />
        ) : (
          <Button
            variant={enabled ? 'outline' : 'default'}
            disabled={me.isPending}
            onClick={() => {
              setSetup({ phase: 'password', mode: enabled ? 'disable' : 'enable' });
            }}
          >
            {enabled ? t('account.twoFactor.disable') : t('account.twoFactor.enable')}
          </Button>
        )}
      </CardContent>

      <Dialog
        open={setup !== null}
        onOpenChange={(open) => {
          if (!open) {
            close();
          }
        }}
      >
        <DialogContent closeLabel={t('actions.close')}>
          {setup?.phase === 'password' ? (
            <form
              method="post"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void confirmPassword();
              }}
            >
              <DialogTitle>{t('account.twoFactor.passwordTitle')}</DialogTitle>
              <DialogDescription>{t('account.twoFactor.passwordDescription')}</DialogDescription>
              {error ? <Alert variant="destructive" title={error} /> : null}
              <FormField id="current-password" label={t('auth.fields.password')}>
                {(control) => (
                  <Input
                    {...control}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                    }}
                    autoFocus
                  />
                )}
              </FormField>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>
                  {t('actions.cancel')}
                </Button>
                <Button type="submit" loading={busy} disabled={password.length === 0}>
                  {t('actions.continue')}
                </Button>
              </DialogFooter>
            </form>
          ) : null}

          {setup?.phase === 'scan' ? (
            <form
              method="post"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
            >
              <DialogTitle>{t('account.twoFactor.scanTitle')}</DialogTitle>
              <DialogDescription>{t('account.twoFactor.scanDescription')}</DialogDescription>
              <div className="flex justify-center rounded-md bg-white p-4">
                <QRCode value={setup.totpURI} size={176} title={t('account.twoFactor.qrLabel')} />
              </div>
              <p className="text-sm">
                {t('account.twoFactor.secret')}: <code className="break-all font-mono">{secret}</code>
              </p>
              <section className="flex flex-col gap-2" aria-labelledby="backup-codes-title">
                <h3 id="backup-codes-title" className="font-medium">
                  {t('account.twoFactor.backupTitle')}
                </h3>
                <p className="text-sm text-muted-foreground">{t('account.twoFactor.backupDescription')}</p>
                <ul className="grid grid-cols-2 gap-1 rounded-md bg-muted p-3 font-mono text-sm">
                  {setup.backupCodes.map((backupCode) => (
                    <li key={backupCode}>{backupCode}</li>
                  ))}
                </ul>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    downloadCodes(setup.backupCodes);
                  }}
                >
                  {t('account.twoFactor.backupDownload')}
                </Button>
              </section>
              <h3 className="font-medium">{t('account.twoFactor.verifyTitle')}</h3>
              <p className="text-sm text-muted-foreground">{t('account.twoFactor.verifyDescription')}</p>
              {error ? <Alert variant="destructive" title={error} /> : null}
              <FormField id="totp-code" label={t('auth.fields.code')}>
                {(control) => (
                  <Input
                    {...control}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value);
                    }}
                  />
                )}
              </FormField>
              <DialogFooter>
                <Button type="submit" loading={busy} disabled={code.trim().length < 6}>
                  {t('account.twoFactor.verifySubmit')}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Better Auth lists the devices only within a day after the sign-in of this session. */
class SessionNotFreshError extends Error {}

function SessionsCard() {
  const t = useTranslations('account.sessions');
  const tActions = useTranslations('actions');
  const tStates = useTranslations('states');
  const format = useFormatter();
  const signOut = useSignOut();
  const current = authClient.useSession();
  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: async () => {
      const result = await authClient.listSessions();
      if (result.error) {
        throw result.error.code === 'SESSION_NOT_FRESH'
          ? new SessionNotFreshError()
          : new Error('sessions unavailable');
      }
      return result.data;
    },
    retry: (failures, error) => !(error instanceof SessionNotFreshError) && failures < 3,
  });

  // Better Auth reports failures in the result instead of throwing them.
  const revoke = async (token: string) => {
    const result = await authClient.revokeSession({ token });
    if (result.error) {
      toast.error(t('revokeFailed'));
    } else {
      toast.success(t('revoked'));
    }
    await sessions.refetch();
  };

  const revokeOthers = async () => {
    const result = await authClient.revokeOtherSessions();
    if (result.error) {
      toast.error(t('revokeFailed'));
    } else {
      toast.success(t('othersRevoked'));
    }
    await sessions.refetch();
  };

  const signInAgain = () => signOut('/login?next=/account/security');

  const currentId = current.data?.session.id;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sessions.isPending ? (
          <LoadingState label={t('loading')} rows={2} />
        ) : sessions.error instanceof SessionNotFreshError ? (
          <Alert title={t('notFresh')}>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void signInAgain()}>
              {t('signInAgain')}
            </Button>
          </Alert>
        ) : sessions.isError ? (
          <ErrorState
            title={tStates('error')}
            action={
              <Button variant="outline" size="sm" onClick={() => void sessions.refetch()}>
                {tActions('retry')}
              </Button>
            }
          />
        ) : sessions.data.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('device')}</TableHead>
                  <TableHead>{t('address')}</TableHead>
                  <TableHead>{t('since')}</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">{t('revoke')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.data.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="max-w-64 truncate" title={session.userAgent ?? undefined}>
                      {session.userAgent ?? t('unknownDevice')}
                      {session.id === currentId ? (
                        <Badge variant="muted" className="ml-2">
                          {t('current')}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>{session.ipAddress ?? ''}</TableCell>
                    <TableCell>
                      {format.dateTime(new Date(session.createdAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      {session.id === currentId ? null : (
                        <Button variant="ghost" size="sm" onClick={() => void revoke(session.token)}>
                          {t('revoke')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {sessions.data.length > 1 ? (
              <Button variant="outline" className="self-start" onClick={() => void revokeOthers()}>
                {t('revokeOthers')}
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
