import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import de from '../../messages/de/common.json';
import en from '../../messages/en/common.json';

import { LOCALE_COOKIE, resolveLocale } from './locale';

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value);

  return {
    locale,
    messages: locale === 'en' ? en : de,
  };
});
