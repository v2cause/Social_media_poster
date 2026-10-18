import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, localeFromCookies, resolveLocale } from './locale';

describe('resolveLocale', () => {
  it('accepts the supported locales', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('de')).toBe('de');
  });

  it('falls back to the default for unsupported or missing values', () => {
    expect(resolveLocale('fr')).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('EN')).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});

describe('localeFromCookies', () => {
  it('prefers the cookie of https, bound to the host, and reads the one of http otherwise', () => {
    const jar = (cookies: Record<string, string>) => (name: string) => cookies[name];

    expect(localeFromCookies(jar({ '__Host-NEXT_LOCALE': 'en', NEXT_LOCALE: 'de' }))).toBe('en');
    expect(localeFromCookies(jar({ NEXT_LOCALE: 'en' }))).toBe('en');
    expect(localeFromCookies(jar({}))).toBe(DEFAULT_LOCALE);
  });
});
