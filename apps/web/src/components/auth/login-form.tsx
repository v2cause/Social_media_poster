'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { signInSchema, type SignInRequest } from '@smp/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  FormField,
  Input,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { authClient } from '@/lib/auth-client';
import { useFieldError } from '@/lib/use-field-error';
import { verificationCallback } from '@/lib/verification-callback';

import { useAuthError, type AuthClientError } from './auth-error';
import { TwoFactorStep } from './two-factor-step';

/** After the verification link: whether it verified the address or failed. */
export type VerificationOutcome = 'verified' | 'failed' | null;

export function LoginForm({
  next,
  verification = null,
}: {
  next: string | null;
  verification?: VerificationOutcome;
}) {
  const t = useTranslations('auth');
  const router = useRouter();
  const queryClient = useQueryClient();
  const fieldError = useFieldError();
  const authError = useAuthError();
  const [error, setError] = useState<string | null>(
    verification === 'failed' ? t('login.verificationFailed') : null,
  );
  const [notice, setNotice] = useState<string | null>(
    verification === 'verified' ? t('login.verified') : null,
  );
  const [twoFactor, setTwoFactor] = useState(false);
  const form = useForm<SignInRequest>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  });

  // Queries another account left in this tab, after a session that ended on the server, go
  // before the new account loads its own (guide step 8.4).
  const finish = () => {
    queryClient.clear();
    router.push(next ?? '/');
    router.refresh();
  };

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    setNotice(null);
    const result = await authClient.signIn.email(values);
    if (result.error) {
      const failure = result.error as AuthClientError;
      if (failure.code === 'EMAIL_NOT_VERIFIED') {
        await authClient.sendVerificationEmail({
          email: values.email,
          callbackURL: verificationCallback(next),
        });
        setNotice(t('login.notVerified'));
        return;
      }
      setError(authError(failure));
      return;
    }
    if ('twoFactorRedirect' in result.data && result.data.twoFactorRedirect) {
      setTwoFactor(true);
      return;
    }
    finish();
  });

  if (twoFactor) {
    return <TwoFactorStep onDone={finish} />;
  }

  const signupHref = next ? `/signup?next=${encodeURIComponent(next)}` : '/signup';
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{t('login.title')}</CardTitle>
        <CardDescription>{t('login.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          {error ? <Alert variant="destructive" title={error} /> : null}
          {notice ? <Alert title={notice} /> : null}
          <FormField id="email" label={t('fields.email')} error={fieldError(form.formState.errors.email)}>
            {(control) => (
              <Input {...control} {...form.register('email')} type="email" autoComplete="email" />
            )}
          </FormField>
          <FormField
            id="password"
            label={t('fields.password')}
            error={fieldError(form.formState.errors.password)}
          >
            {(control) => (
              <Input
                {...control}
                {...form.register('password')}
                type="password"
                autoComplete="current-password"
              />
            )}
          </FormField>
          <Button type="submit" loading={form.formState.isSubmitting}>
            {t('login.submit')}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex-col items-start gap-2 text-sm">
        <Link className="text-primary underline-offset-4 hover:underline" href="/forgot-password">
          {t('login.forgot')}
        </Link>
        <p className="text-muted-foreground">
          {t('login.noAccount')}{' '}
          <Link className="text-primary underline-offset-4 hover:underline" href={signupHref}>
            {t('login.signupLink')}
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
