import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { oauthRandom } from './oauth-random';

describe('oauthRandom', () => {
  it('makes states of 32 random bytes in base64url', () => {
    const states = new Set(Array.from({ length: 100 }, () => oauthRandom.token()));
    expect(states.size).toBe(100);
    for (const state of states) {
      expect(state).toMatch(/^[\w-]{43}$/);
    }
  });

  it('pairs a verifier with its S256 challenge', () => {
    const { verifier, challenge } = oauthRandom.pkce();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    // The example of RFC 7636, appendix B.
    expect(
      createHash('sha256').update('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk').digest('base64url'),
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
