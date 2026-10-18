'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema } from '@smp/contracts';
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
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { authClient } from '@/lib/auth-client';
import { useFieldError } from '@/lib/use-field-error';

/** Requests a reset link. The answer is the same for known and unknown addresses. */
export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const fieldError = useFieldError();
  const [sent, setSent] = useState(false);
  const form = useForm<z.infer<typeof forgotPasswordSchema>>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const submit = form.handleSubmit(async ({ email }) => {
    await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' }).catch(() => undefined);
    setSent(true);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('forgotPassword.title')}</CardTitle>
        <CardDescription>{t('forgotPassword.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <Alert variant="success" title={t('forgotPassword.sent')} />
        ) : (
          <form
            method="post"
            className="flex flex-col gap-4"
            onSubmit={(event) => void submit(event)}
            noValidate
          >
            <FormField id="email" label={t('fields.email')} error={fieldError(form.formState.errors.email)}>
              {(control) => (
                <Input {...control} {...form.register('email')} type="email" autoComplete="email" />
              )}
            </FormField>
            <Button type="submit" loading={form.formState.isSubmitting}>
              {t('forgotPassword.submit')}
            </Button>
          </form>
        )}
      </CardContent>
      <CardFooter>
        <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/login">
          {t('forgotPassword.back')}
        </Link>
      </CardFooter>
    </Card>
  );
}
