'use client';

import { useAccountsList } from '@smp/api-client';
import { Badge, Button, EmptyState, ErrorState, LoadingState } from '@smp/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { STATUS_BADGE } from '@/features/accounts/account-model';
import { PlatformMark } from '@/features/publishing/platform-mark';

// The connected accounts on the dashboard (guide step 4.11), with the state of their access.

export function ConnectedAccounts(props: { ws: string }) {
  const t = useTranslations('dashboard');
  const statuses = useTranslations('accounts.list.status');
  const states = useTranslations('states');
  const accounts = useAccountsList(props.ws);
  const toAccounts = (
    <Button asChild variant="outline" size="sm">
      <Link href={`/w/${props.ws}/accounts`}>{t('toAccounts')}</Link>
    </Button>
  );

  if (accounts.isPending) {
    return <LoadingState label={states('loading')} rows={2} />;
  }
  if (accounts.isError) {
    return <ErrorState title={states('error')} />;
  }
  if (accounts.data.items.length === 0) {
    return <EmptyState title={t('noAccounts')} description={t('noAccountsHint')} action={toAccounts} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {accounts.data.items.map((account) => (
          <li key={account.id} className="flex items-center gap-2 text-sm">
            <PlatformMark platform={account.platform} />
            <span className="min-w-0 flex-1 truncate">{account.name}</span>
            <Badge variant={STATUS_BADGE[account.status]}>{statuses(account.status)}</Badge>
          </li>
        ))}
      </ul>
      <div>{toAccounts}</div>
    </div>
  );
}
