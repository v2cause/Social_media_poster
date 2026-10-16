import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@smp/ui';
import { getFormatter, getTranslations } from 'next-intl/server';

import { AcceptInvitationButton } from '@/components/auth/accept-invitation-button';
import { getInvitationPreview, getSession } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('auth.invite');
  return { title: t('title') };
}

/** The link of the invitation email: who invites, which role, and the way in (guide step 1.9). */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations();
  const format = await getFormatter();
  const [preview, me] = await Promise.all([getInvitationPreview(token), getSession()]);

  if (!preview) {
    return <Alert variant="destructive" title={t('auth.invite.notFound')} />;
  }
  const here = `/invite/${encodeURIComponent(token)}`;
  const description = preview.invitedBy
    ? t('auth.invite.description', { inviter: preview.invitedBy, organization: preview.organizationName })
    : t('auth.invite.descriptionWithoutInviter', { organization: preview.organizationName });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.invite.title')}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-1 text-sm">
          <li>{t('auth.invite.role', { role: t(`roles.${preview.role}`) })}</li>
          <li>{t('auth.invite.email', { email: preview.email })}</li>
          <li>{t('auth.invite.expires', { date: format.dateTime(new Date(preview.expiresAt), 'short') })}</li>
        </ul>
        {preview.status === 'expired' ? (
          <Alert variant="destructive" title={t('auth.invite.expired')} />
        ) : null}
        {preview.status === 'used' ? <Alert variant="destructive" title={t('auth.invite.used')} /> : null}
        {preview.status === 'open' ? (
          <AcceptInvitationButton
            token={token}
            here={here}
            invitedEmail={preview.email}
            signedInEmail={me?.email ?? null}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
