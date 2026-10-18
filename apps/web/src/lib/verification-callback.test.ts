import { describe, expect, it } from 'vitest';

import { safeNext } from './safe-next';
import { verificationCallback } from './verification-callback';

describe('verificationCallback', () => {
  it('leads to the sign-in and keeps the page to go to after it', () => {
    expect(verificationCallback('/invite/abc')).toBe('/login?verified=1&next=%2Finvite%2Fabc');
    expect(verificationCallback(null)).toBe('/login?verified=1&next=%2Fonboarding');
  });

  it('stays a path on this site', () => {
    expect(safeNext(verificationCallback('/w/demo/dashboard'))).toBe(
      '/login?verified=1&next=%2Fw%2Fdemo%2Fdashboard',
    );
  });
});
