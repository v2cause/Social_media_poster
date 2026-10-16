import { redirect } from 'next/navigation';

import { getSession, homePath } from '@/lib/server/api';

/** The start page sends everyone where they belong: sign-in, onboarding or their workspace. */
export default async function HomePage() {
  if (!(await getSession())) {
    redirect('/login');
  }
  redirect(await homePath());
}
