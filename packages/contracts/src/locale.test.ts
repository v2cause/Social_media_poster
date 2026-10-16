import { describe, expect, it } from 'vitest';

import { localeSchema, toLocale } from './locale';
import { timezoneSchema } from './timezone';

describe('locale and time zone', () => {
  it('accepts the supported locales and falls back to German', () => {
    expect(localeSchema.parse('en')).toBe('en');
    expect(toLocale('fr')).toBe('de');
    expect(toLocale(undefined)).toBe('de');
  });

  it('accepts IANA time zones only', () => {
    expect(timezoneSchema.safeParse('Europe/Berlin').success).toBe(true);
    expect(timezoneSchema.safeParse('UTC').success).toBe(true);
    expect(timezoneSchema.safeParse('Mars/Olympus').success).toBe(false);
  });
});
