import { getTranslations } from 'next-intl/server';

import { BillingPage } from '@/features/billing/billing-page';
import { getOrganizationContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('billing');
  return { title: t('title') };
}

/** Plan, usage, plans and invoices of an organization (guide step 7.5); the way back from Stripe. */
export default async function BillingRoute({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ checkout?: string | string[] }>;
}) {
  const [{ org }, { checkout }] = await Promise.all([params, searchParams]);
  const context = await getOrganizationContext(org);
  return (
    <BillingPage
      organizationId={context.organization.id}
      organizationName={context.organization.name}
      role={context.role}
      checkout={checkout === 'success' || checkout === 'canceled' ? checkout : null}
    />
  );
}
