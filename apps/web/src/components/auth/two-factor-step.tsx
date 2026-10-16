'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { twoFactorCodeSchema } from '@smp/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  FormField,
  Input,
  Label,
} from '@smp/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { authClient } from '@/lib/auth-client';
import { useFieldError } from '@/lib/use-field-error';

import { useAuthError } from './auth-error';

/** Second step of the sign-in: a TOTP code from the app or a backup code. */
export function TwoFactorStep({ onDone }: { onDone: () => void }) {
  const t = useTranslations('auth');
  const fieldError = useFieldError();
  const authError = useAuthError();
  const [backup, setBackup] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof twoFactorCodeSchema>>({
    resolver: zodResolver(twoFactorCodeSchema),
    defaultValues: { code: '' },
  });

  const submit = form.handleSubmit(async ({ code }) => {
    setError(null);
    const result = backup
      ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice });
    if (result.error) {
      setError(authError(result.error));
      return;
    }
    onDone();
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('twoFactor.title')}</CardTitle>
        <CardDescription>
          {backup ? t('twoFactor.backupDescription') : t('twoFactor.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
          {error ? <Alert variant="destructive" title={error} /> : null}
          <FormField
            id="code"
            label={t('fields.code')}
            error={fieldError(form.formState.errors.code, { minimum: 6 })}
          >
            {(control) => (
              <Input
                {...control}
                {...form.register('code')}
                autoComplete="one-time-code"
                inputMode={backup ? 'text' : 'numeric'}
                autoFocus
              />
            )}
          </FormField>
          <div className="flex items-center gap-2">
            <Checkbox
              id="trust-device"
              checked={trustDevice}
              onChange={(event) => {
                setTrustDevice(event.target.checked);
              }}
            />
            <Label htmlFor="trust-device">{t('twoFactor.trustDevice')}</Label>
          </div>
          <Button type="submit" loading={form.formState.isSubmitting}>
            {t('twoFactor.submit')}
          </Button>
          <Button
            type="button"
            variant="link"
            onClick={() => {
              setBackup((value) => !value);
            }}
          >
            {backup ? t('twoFactor.useApp') : t('twoFactor.useBackup')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
