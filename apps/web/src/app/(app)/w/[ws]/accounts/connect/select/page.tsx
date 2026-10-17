import { pendingConnectionIdSchema } from '@smp/contracts';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ConnectSelectPage } from '@/features/accounts/connect-select-page';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('accounts.select');
  return { title: t('title') };
}

/** The selection after the consent of a platform; only owners and admins connect accounts. */
export default async function ConnectSelectRoute({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ ws }, query] = await Promise.all([params, searchParams]);
  const { permissions } = await getWorkspaceContext(ws);
  if (!permissions.includes('account.manage')) {
    notFound();
  }
  const pending = pendingConnectionIdSchema.safeParse(query['pending']);
  return <ConnectSelectPage ws={ws} pendingId={pending.success ? pending.data : null} />;
}
