import type { ReactNode } from 'react';

import { AppShell } from '@/components/app-shell';
import { getMemberships, requireSession } from '@/lib/server/api';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const me = await requireSession('/admin');
  const memberships = await getMemberships();
  return (
    <AppShell user={{ name: me.name, email: me.email }} memberships={memberships} area={{ kind: 'account' }}>
      {children}
    </AppShell>
  );
}
