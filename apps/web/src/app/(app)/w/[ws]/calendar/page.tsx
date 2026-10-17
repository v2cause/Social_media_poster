import { getTranslations } from 'next-intl/server';

import { CalendarPage } from '@/features/calendar/calendar-page';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('calendar');
  return { title: t('title') };
}

export default async function CalendarRoute({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { workspace, permissions } = await getWorkspaceContext(ws);
  return (
    <CalendarPage ws={ws} timeZone={workspace.timezone} canSchedule={permissions.includes('post.schedule')} />
  );
}
