import type { ReactNode } from 'react';

import { AppShell } from '@/components/app-shell';
import { getMemberships, getWorkspaceContext, requireSession } from '@/lib/server/api';

/**
 * The shell of a workspace (guide step 1.9). The session and the workspace are checked on the
 * server before anything renders; unknown or foreign workspaces show the 404 page.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  const me = await requireSession(`/w/${ws}/dashboard`);
  const [context, memberships] = await Promise.all([getWorkspaceContext(ws), getMemberships()]);

  return (
    <AppShell
      user={{ name: me.name, email: me.email }}
      memberships={memberships}
      area={{
        kind: 'workspace',
        slug: context.workspace.slug,
        workspaceName: context.workspace.name,
        organizationId: context.organization.id,
        role: context.role,
      }}
    >
      {children}
    </AppShell>
  );
}
