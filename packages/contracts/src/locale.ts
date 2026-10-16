import { z } from 'zod';

/** Languages of the interface and of emails. German is the default (architecture 11). */
export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'de';

export const localeSchema = z.enum(LOCALES);

/** Maps any stored or requested value to a supported locale. */
export const toLocale = (value: unknown): Locale => {
  const parsed = localeSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_LOCALE;
};
