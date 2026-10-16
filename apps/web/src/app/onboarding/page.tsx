import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { LanguageSwitcher } from '@/components/language-switcher';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { getMemberships, requireSession } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('onboarding');
  return { title: t('title') };
}

/** First steps after the email is verified: organization, workspace profile, done. */
export default async function OnboardingPage() {
  await requireSession('/onboarding');
  const first = (await getMemberships()).flatMap((membership) => membership.workspaces)[0];
  if (first) {
    redirect(`/w/${first.slug}/dashboard`);
  }
  const t = await getTranslations('app');
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between p-4">
        <span className="font-semibold">{t('name')}</span>
        <LanguageSwitcher signedIn />
      </header>
      <main className="flex flex-1 justify-center p-4 pt-[6vh]">
        <div className="w-full max-w-xl">
          <OnboardingWizard />
        </div>
      </main>
    </div>
  );
}
