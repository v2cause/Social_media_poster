'use client';

import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@smp/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { authClient } from '@/lib/auth-client';
import { verificationCallback } from '@/lib/verification-callback';

/**
 * After sign-up: check the inbox. The link verifies the address and leads to the sign-in, then on
 * to the onboarding or back to the invitation.
 */
export function VerifyEmailCard({ email, next }: { email: string | null; next: string }) {
  const t = useTranslations('auth.verifyEmail');
  const [sending, setSending] = useState(false);
  const [resent, setResent] = useState(false);

  const resend = async () => {
    if (!email) {
      return;
    }
    setSending(true);
    // The answer is the same for every address, so it reveals nothing.
    await authClient
      .sendVerificationEmail({ email, callbackURL: verificationCallback(next) })
      .catch(() => undefined);
    setSending(false);
    setResent(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description', { email: email ?? 'none' })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {resent ? <Alert variant="success" title={t('resent')} /> : null}
        {email ? (
          <Button variant="outline" onClick={() => void resend()} loading={sending}>
            {t('resend')}
          </Button>
        ) : null}
      </CardContent>
      <CardFooter>
        <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/login">
          {t('back')}
        </Link>
      </CardFooter>
    </Card>
  );
}
