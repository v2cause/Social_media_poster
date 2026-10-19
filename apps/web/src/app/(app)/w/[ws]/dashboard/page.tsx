import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@smp/ui';
import { getTranslations } from 'next-intl/server';

import { AnalyticsSummary } from '@/features/dashboard/analytics-summary';
import { ConnectedAccounts } from '@/features/dashboard/connected-accounts';
import { NextPosts } from '@/features/dashboard/next-posts';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('dashboard');
  return { title: t('title') };
}

/**
 * The dashboard: welcome, the KPIs and top posts of the last 30 days, the next planned posts with
 * a countdown and the connected accounts.
 */
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
      <Card>
        <CardHeader>
          <CardTitle>{t('analytics.dashboard.title')}</CardTitle>
          <CardDescription>{context.workspace.timezone}</CardDescription>
        </CardHeader>
        <CardContent>
          <AnalyticsSummary ws={ws} timeZone={context.workspace.timezone} />
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.nextPosts')}</CardTitle>
            <CardDescription>{context.workspace.timezone}</CardDescription>
          </CardHeader>
          <CardContent>
            <NextPosts ws={ws} timeZone={context.workspace.timezone} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.accounts')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ConnectedAccounts ws={ws} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
