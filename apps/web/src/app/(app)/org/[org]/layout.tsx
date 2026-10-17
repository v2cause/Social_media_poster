import type { ReactNode } from 'react';

import { AppShell } from '@/components/app-shell';
import { noticeOf } from '@/features/billing/billing-model';
import { getMemberships, getOrganizationContext, requireSession } from '@/lib/server/api';

/** The shell of the organization pages; non-members see the 404 page. */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const me = await requireSession(`/org/${org}/members`);
  const [context, memberships] = await Promise.all([getOrganizationContext(org), getMemberships()]);

  return (
    <AppShell
      user={{ name: me.name, email: me.email }}
      memberships={memberships}
      area={{
        kind: 'organization',
        organizationId: context.organization.id,
        organizationName: context.organization.name,
        role: context.role,
        billingNotice: noticeOf(context.billing, new Date()),
      }}
    >
      {children}
    </AppShell>
  );
}
