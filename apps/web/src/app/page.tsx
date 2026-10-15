import { getTranslations } from 'next-intl/server';

const NAV_KEYS = [
  'dashboard',
  'create',
  'calendar',
  'posts',
  'ideas',
  'media',
  'analytics',
  'accounts',
  'brandVoices',
  'settings',
] as const;

export default async function HomePage() {
  const t = await getTranslations('shell');
  const nav = await getTranslations('nav');

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-border p-4 max-md:hidden">
        <nav aria-label={t('navigation')}>
          <ul className="flex flex-col gap-1 text-sm">
            {NAV_KEYS.map((key) => (
              <li key={key} className="rounded-md px-2 py-1.5 text-muted-foreground">
                {nav(key)}
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main className="flex flex-1 flex-col gap-3 p-8 max-md:p-4">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('subtitle')}</p>
        <p className="text-sm text-muted-foreground">{t('status')}</p>
      </main>
    </div>
  );
}
