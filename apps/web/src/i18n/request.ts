import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { localeFromCookies } from './locale';
import { messagesFor } from './messages';

// The language comes from the cookie the language switcher sets; German is the default
// (architecture 11). Dates show in Central European time until workspaces bring their own zone.
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const locale = localeFromCookies((name) => cookieStore.get(name)?.value);

  return {
    locale,
    messages: messagesFor(locale),
    timeZone: 'Europe/Berlin',
  };
});
