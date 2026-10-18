import { z } from 'zod';

export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'de';
export const LOCALE_COOKIE = 'NEXT_LOCALE';
/** Its name over https: bound to this host and never sent in plain text (guide step 8.4). */
export const SECURE_LOCALE_COOKIE = `__Host-${LOCALE_COOKIE}`;

// The cookie is client input. Anything other than a supported locale falls back to the default.
const localeSchema = z.enum(LOCALES).catch(DEFAULT_LOCALE);

export function resolveLocale(value: string | undefined): Locale {
  return localeSchema.parse(value);
}

/** The locale of a request: the cookie of https first, then the one of http (local). */
export function localeFromCookies(cookie: (name: string) => string | undefined): Locale {
  return resolveLocale(cookie(SECURE_LOCALE_COOKIE) ?? cookie(LOCALE_COOKIE));
}
