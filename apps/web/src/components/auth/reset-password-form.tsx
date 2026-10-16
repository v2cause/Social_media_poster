'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, resetPasswordSchema } from '@smp/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FormField,
  Input,
} from '@smp/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { authClient } from '@/lib/auth-client';
import { useFieldError } from '@/lib/use-field-error';

import { useAuthError } from './auth-error';

export function ResetPasswordForm({ token }: { token: string | null }) {
  const t = useTranslations('auth');
  const fieldError = useFieldError();
  const authError = useAuthError();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof resetPasswordSchema>>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirm: '' },
  });

  const submit = form.handleSubmit(async ({ password }) => {
    if (!token) {
      return;
    }
    setError(null);
    const result = await authClient.resetPassword({ newPassword: password, token });
    if (result.error) {
      setError(authError(result.error));
      return;
    }
    setDone(true);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('resetPassword.title')}</CardTitle>
        <CardDescription>{t('resetPassword.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!token ? (
          <>
            <Alert variant="destructive" title={t('resetPassword.invalid')} />
            <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/forgot-password">
              {t('resetPassword.requestNew')}
            </Link>
          </>
        ) : done ? (
          <>
            <Alert variant="success" title={t('resetPassword.done')} />
            <Button asChild>
              <Link href="/login">{t('resetPassword.login')}</Link>
            </Button>
          </>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
            {error ? <Alert variant="destructive" title={error} /> : null}
            <FormField
              id="password"
              label={t('fields.newPassword')}
              hint={t('passwordHint', { min: PASSWORD_MIN_LENGTH })}
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
              id="confirm"
              label={t('fields.confirmPassword')}
              error={fieldError(form.formState.errors.confirm)}
            >
              {(control) => (
                <Input
                  {...control}
                  {...form.register('confirm')}
                  type="password"
                  autoComplete="new-password"
                />
              )}
            </FormField>
            <Button type="submit" loading={form.formState.isSubmitting}>
              {t('resetPassword.submit')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
