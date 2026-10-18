import { describe, expect, it } from 'vitest';

import { safeNext } from './safe-next';

describe('safeNext', () => {
  it('keeps paths on this site', () => {
    expect(safeNext('/invite/abc')).toBe('/invite/abc');
    expect(safeNext('/w/demo/dashboard?tab=1')).toBe('/w/demo/dashboard?tab=1');
    expect(safeNext('/w/demo/posts#later')).toBe('/w/demo/posts#later');
    // Encoded slashes stay part of the path.
    expect(safeNext('/%2F%2Fevil.example')).toBe('/%2F%2Fevil.example');
  });

  it('refuses other sites and odd input', () => {
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('relative/path')).toBe('/');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('')).toBe('/');
  });

  it('refuses control characters and backslashes the URL parser would drop or turn into slashes', () => {
    // As the query parameter next=%2F%09%2Fevil.example arrives after decoding.
    expect(safeNext('/\t/evil.example')).toBe('/');
    expect(safeNext('/\n/evil.example')).toBe('/');
    expect(safeNext('/\r/evil.example')).toBe('/');
    expect(safeNext('/w/\\\\evil.example')).toBe('/');
    expect(safeNext('/\u0000/evil.example')).toBe('/');
    expect(safeNext('/\u007f')).toBe('/');
  });
});
