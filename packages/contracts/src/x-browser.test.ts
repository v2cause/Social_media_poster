import { describe, expect, it } from 'vitest';

import { enableXBrowserSchema, startXbLoginSchema, xbLoginCodeSchema } from './x-browser';

describe('X browser contracts', () => {
  it('switches on only with the checkbox ticked and a password', () => {
    const valid = { version: '2026-10-17', locale: 'de', accepted: true, password: 'secret-password' };
    expect(enableXBrowserSchema.safeParse(valid).success).toBe(true);
    expect(enableXBrowserSchema.safeParse({ ...valid, accepted: false }).success).toBe(false);
    expect(enableXBrowserSchema.safeParse({ ...valid, password: '' }).success).toBe(false);
  });

  it('trims the user name and takes the codes of apps, text messages and backups', () => {
    expect(startXbLoginSchema.parse({ username: '  smp_demo ', password: 'p', locale: 'en' }).username).toBe(
      'smp_demo',
    );
    expect(startXbLoginSchema.safeParse({ username: 'smp_demo', password: 'p' }).success).toBe(false);
    expect(xbLoginCodeSchema.safeParse({ code: ' 123456 ' }).success).toBe(true);
    expect(xbLoginCodeSchema.safeParse({ code: 'ab12cd34ef56' }).success).toBe(true);
    expect(xbLoginCodeSchema.safeParse({ code: '12 34' }).success).toBe(false);
  });
});
