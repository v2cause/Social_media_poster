import { connectFailureSchema } from '@smp/contracts';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { AccountsPage } from '@/features/accounts/accounts-page';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('accounts');
  return { title: t('title') };
}

// The query of the way back from the OAuth callback and the selection page is client input.
const connectedSchema = z.coerce.number().int().min(1).max(50);

export default async function AccountsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ ws }, query] = await Promise.all([params, searchParams]);
  const { permissions } = await getWorkspaceContext(ws);
  const error = query['connect_error'];
  const connected = connectedSchema.safeParse(query['connected']);
  return (
    <AccountsPage
      ws={ws}
      canManage={permissions.includes('account.manage')}
      connectError={error === undefined ? null : (connectFailureSchema.safeParse(error).data ?? 'other')}
      connected={connected.success ? connected.data : null}
    />
  );
}
