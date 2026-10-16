import { createHash, randomBytes } from 'node:crypto';

import type { OAuthRandom } from '@smp/core';

// The random values of the OAuth flow (guide step 4.5, architecture 10): states and ids of
// pending connections from 32 random bytes, and PKCE pairs with the S256 method (RFC 7636).

const token = (): string => randomBytes(32).toString('base64url');

export const oauthRandom: OAuthRandom = {
  token,
  pkce() {
    // 32 bytes give the 43 characters of the shortest verifier RFC 7636 allows.
    const verifier = token();
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  },
};
