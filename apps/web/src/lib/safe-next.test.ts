import { describe, expect, it } from 'vitest';

import { safeNext } from './safe-next';

describe('safeNext', () => {
  it('keeps paths on this site', () => {
    expect(safeNext('/invite/abc')).toBe('/invite/abc');
    expect(safeNext('/w/demo/dashboard?tab=1')).toBe('/w/demo/dashboard?tab=1');
  });

  it('refuses other sites and odd input', () => {
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});
