import { getTranslations } from 'next-intl/server';

import { TeamPage } from '@/components/team/team-page';
import { getOrganizationContext, getSession } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('team');
  return { title: t('title') };
}

export default async function MembersPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const [context, me] = await Promise.all([getOrganizationContext(org), getSession()]);
  return (
    <TeamPage
      organizationId={context.organization.id}
      organizationName={context.organization.name}
      role={context.role}
      currentUserId={me?.id ?? ''}
    />
  );
}
