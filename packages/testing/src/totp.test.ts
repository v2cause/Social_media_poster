import { describe, expect, it } from 'vitest';

import { totpCode, totpCodes } from './totp';

describe('totpCode', () => {
  it('matches the RFC 6238 test vector for SHA-1', () => {
    // Secret "12345678901234567890" in base32, time 59 s: 94287082 (last six digits).
    expect(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
  });

  it('reads the secret from an otpauth URI', () => {
    const uri = 'otpauth://totp/App:ada?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=App';
    expect(totpCode(uri, 59_000)).toBe('287082');
  });
});

describe('totpCodes', () => {
  it('hands out the codes of the current, the next and the previous step once each', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const now = Date.now();
    const next = totpCodes(secret);

    const codes = [next(), next(), next()];

    expect(new Set(codes).size).toBe(3);
    expect(codes).toContain(totpCode(secret, now));
    expect(next).toThrow(/wait for the next step/);
  });
});
