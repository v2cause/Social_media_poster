import { LOCALE_COOKIE, type Locale } from '@/i18n/locale';

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Remembers the interface language for the next requests; over https only there (guide step 8.4). */
export function writeLocaleCookie(locale: Locale): void {
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${String(ONE_YEAR)}; samesite=lax${secure}`;
}
