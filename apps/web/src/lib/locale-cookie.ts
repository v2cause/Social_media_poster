import { LOCALE_COOKIE, SECURE_LOCALE_COOKIE, type Locale } from '@/i18n/locale';

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Remembers the interface language for the next requests. Over https the cookie is Secure and
 * carries the prefix __Host-, so no other host can set it (guide step 8.4).
 */
export function writeLocaleCookie(locale: Locale): void {
  const attributes = `path=/; max-age=${String(ONE_YEAR)}; samesite=lax`;
  document.cookie =
    window.location.protocol === 'https:'
      ? `${SECURE_LOCALE_COOKIE}=${locale}; ${attributes}; secure`
      : `${LOCALE_COOKIE}=${locale}; ${attributes}`;
}
