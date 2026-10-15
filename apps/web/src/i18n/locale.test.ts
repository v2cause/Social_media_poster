import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, resolveLocale } from './locale';

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
