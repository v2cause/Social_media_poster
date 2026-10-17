import { getTranslations } from 'next-intl/server';

import { DataPage } from '@/features/data/data-page';
import { getOrganizationContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('data');
  return { title: t('title') };
}

/** The export of all data of an organization for its owners (guide step 8.1). */
export default async function DataRoute({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await getOrganizationContext(org);
  return (
    <DataPage
      organizationId={context.organization.id}
      organizationName={context.organization.name}
      role={context.role}
    />
  );
}
