import { EmptyState } from '@smp/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

// Sections of the navigation that arrive with later phases. Each one gets its own route then,
// which takes precedence over this placeholder.
const UPCOMING = {
  calendar: 'calendar',
  analytics: 'analytics',
  settings: 'settings',
} as const;

type Section = keyof typeof UPCOMING;

const isSection = (value: string): value is Section => value in UPCOMING;

export default async function UpcomingSection({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!isSection(section)) {
    notFound();
  }
  const t = await getTranslations();
  const name = t(`nav.${UPCOMING[section]}`);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{name}</h1>
      <EmptyState
        title={t('section.upcoming')}
        description={t('section.upcomingDescription', { section: name })}
      />
    </div>
  );
}
