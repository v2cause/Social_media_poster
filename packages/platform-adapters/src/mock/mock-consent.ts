import type { Platform } from '@smp/platform-rules';

import { encodeMockCode } from './mock-code';

// What the fake OAuth page of the API offers (guide step 4.4): grant every requested scope, grant
// all but one, so the comparison of granted and requested scopes has a gap to show (step 4.5), or
// deny. Each choice leads back to the callback like a real authorization server: with a code and
// the state, or with error=access_denied.

/** The scope the partial grant leaves out: the statistics, and for X the refresh token. */
export const MOCK_PARTIAL_GRANT_DROPS: Readonly<Record<Platform, string>> = {
  LINKEDIN: 'r_member_postAnalytics',
  FACEBOOK: 'read_insights',
  INSTAGRAM: 'instagram_business_manage_insights',
  X: 'offline.access',
};

/** How long a code of the page can be exchanged. */
export const MOCK_CODE_TTL_MS = 10 * 60 * 1000;

/** The account every grant of the page belongs to, so a second grant reconnects it. */
export const MOCK_USER = 'mock-user';

export interface MockConsentRequest {
  platform: Platform;
  state: string;
  /** The callback of the API, already checked by the page. */
  redirectUri: string;
  scopes: readonly string[];
  codeChallenge: string | null;
  now: number;
}

export interface MockConsentLinks {
  allow: string;
  /** Null when the request does not ask for the scope the partial grant leaves out. */
  partial: { url: string; without: string } | null;
  deny: string;
}

export function mockConsentLinks(request: MockConsentRequest): MockConsentLinks {
  const callback = (params: Record<string, string>): string => {
    const url = new URL(request.redirectUri);
    for (const [key, value] of Object.entries({ ...params, state: request.state })) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  };
  const codeFor = (scopes: readonly string[]): string =>
    encodeMockCode({
      platform: request.platform,
      user: MOCK_USER,
      scopes: [...scopes],
      challenge: request.codeChallenge,
      expiresAt: request.now + MOCK_CODE_TTL_MS,
    });
  const without = MOCK_PARTIAL_GRANT_DROPS[request.platform];

  return {
    allow: callback({ code: codeFor(request.scopes) }),
    partial: request.scopes.includes(without)
      ? {
          url: callback({ code: codeFor(request.scopes.filter((scope) => scope !== without)) }),
          without,
        }
      : null,
    deny: callback({ error: 'access_denied', error_description: 'The user denied the request.' }),
  };
}
