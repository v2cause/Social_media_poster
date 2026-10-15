import { z } from 'zod';

export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'de';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

// The cookie is client input. Anything other than a supported locale falls back to the default.
const localeSchema = z.enum(LOCALES).catch(DEFAULT_LOCALE);

export function resolveLocale(value: string | undefined): Locale {
  return localeSchema.parse(value);
}
