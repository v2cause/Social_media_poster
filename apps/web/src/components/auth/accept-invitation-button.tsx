'use client';

import { invitationsAccept } from '@smp/api-client';
import { Alert, Button } from '@smp/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useErrorMessage } from '@/lib/use-error-message';

/** Accept when signed in with the invited address, else the ways to sign in or up. */
export function AcceptInvitationButton(props: {
  token: string;
  here: string;
  invitedEmail: string;
  signedInEmail: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!props.signedInEmail) {
    const next = encodeURIComponent(props.here);
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {t('auth.invite.signedOutHint', { email: props.invitedEmail })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={`/signup?next=${next}&email=${encodeURIComponent(props.invitedEmail)}`}>
              {t('auth.invite.signUp')}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/login?next=${next}`}>{t('auth.invite.signIn')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (props.signedInEmail.toLowerCase() !== props.invitedEmail.toLowerCase()) {
    return (
      <Alert variant="destructive" title={t('auth.invite.wrongAccount', { email: props.signedInEmail })} />
    );
  }

  const accept = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await invitationsAccept({ token: props.token });
      router.push(result.workspaceSlug ? `/w/${result.workspaceSlug}/dashboard` : '/');
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error ? <Alert variant="destructive" title={error} /> : null}
      <Button onClick={() => void accept()} loading={pending}>
        {t('auth.invite.accept')}
      </Button>
    </div>
  );
}
