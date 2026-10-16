import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from '@smp/ui';
import { getTranslations } from 'next-intl/server';

import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('dashboard');
  return { title: t('title') };
}

/** Phase 1 dashboard: welcome and the empty states of what the next phases fill. */
export default async function DashboardPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const context = await getWorkspaceContext(ws);
  const t = await getTranslations();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {t('dashboard.welcome', { workspace: context.workspace.name })}
        </h1>
        <p className="text-muted-foreground">{t('dashboard.intro')}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('dashboard.role', { role: t(`roles.${context.role}`) })}
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.nextPosts')}</CardTitle>
            <CardDescription>{context.workspace.timezone}</CardDescription>
          </CardHeader>
          <CardContent>
            <EmptyState title={t('dashboard.noPosts')} description={t('dashboard.noPostsHint')} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.accounts')}</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState title={t('dashboard.noAccounts')} description={t('dashboard.noAccountsHint')} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
