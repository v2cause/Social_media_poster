'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, signUpSchema, type SignUpRequest } from '@smp/contracts';
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
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { authClient } from '@/lib/auth-client';
import { verificationCallback } from '@/lib/verification-callback';
import { useFieldError } from '@/lib/use-field-error';

import { useAuthError } from './auth-error';

export function SignupForm({ next, email }: { next: string | null; email: string }) {
  const t = useTranslations('auth');
  const locale = useLocale();
  const router = useRouter();
  const fieldError = useFieldError();
  const authError = useAuthError();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<SignUpRequest>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { name: '', email, password: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    const destination = next ?? '/onboarding';
    const result = await authClient.signUp.email({
      ...values,
      locale,
      callbackURL: verificationCallback(destination),
    });
    if (result.error) {
      setError(authError(result.error));
      return;
    }
    const query = new URLSearchParams({ email: values.email, next: destination });
    router.push(`/verify-email?${query.toString()}`);
  });

  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : '/login';
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{t('signup.title')}</CardTitle>
        <CardDescription>{t('signup.description')}</CardDescription>
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
            id="name"
            label={t('fields.name')}
            error={fieldError(form.formState.errors.name, { maximum: 100 })}
          >
            {(control) => <Input {...control} {...form.register('name')} autoComplete="name" />}
          </FormField>
          <FormField id="email" label={t('fields.email')} error={fieldError(form.formState.errors.email)}>
            {(control) => (
              <Input {...control} {...form.register('email')} type="email" autoComplete="email" />
            )}
          </FormField>
          <FormField
            id="password"
            label={t('fields.password')}
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
          <Button type="submit" loading={form.formState.isSubmitting}>
            {t('signup.submit')}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        {t('signup.haveAccount')}{' '}
        <Link className="ml-1 text-primary underline-offset-4 hover:underline" href={loginHref}>
          {t('signup.loginLink')}
        </Link>
      </CardFooter>
    </Card>
  );
}
