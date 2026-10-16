import { randomBytes } from 'node:crypto';

import {
  PlatformError,
  type AuthorizationRequest,
  type Clock,
  type ConnectableAccount,
  type OAuthConnector,
  type OAuthGrant,
  type TokenSet,
} from '@smp/core';
import type { Platform } from '@smp/platform-rules';

import { PLATFORM_SCOPES } from '../scopes';
import { decodeMockCode, pkceChallengeOf } from './mock-code';
import type { MockPlatformStore } from './mock-platform-store';

// The OAuth side of the mock platforms (guide step 4.4): the authorization goes to the fake page
// of the API, the code exchange checks state-independent parts like the PKCE verifier, and the
// tokens live as long as on the real platform. X uses PKCE and rotating refresh tokens like the
// real one; the others do not.

const DAY_MS = 24 * 60 * 60 * 1000;

const LIFETIMES: Readonly<Record<Platform, { accessMs: number; refreshMs: number | null }>> = {
  LINKEDIN: { accessMs: 60 * DAY_MS, refreshMs: null },
  FACEBOOK: { accessMs: 60 * DAY_MS, refreshMs: null },
  INSTAGRAM: { accessMs: 60 * DAY_MS, refreshMs: null },
  X: { accessMs: 2 * 60 * 60 * 1000, refreshMs: 180 * DAY_MS },
};

const token = (kind: string): string => `mock-${kind}-${randomBytes(18).toString('base64url')}`;

export class MockOAuthConnector implements OAuthConnector {
  readonly scopes: readonly string[];
  readonly usesPkce: boolean;

  constructor(
    private readonly platform: Platform,
    private readonly options: { authorizeUrl?: string; clock: Clock; store: MockPlatformStore },
  ) {
    this.scopes = PLATFORM_SCOPES[platform];
    this.usesPkce = platform === 'X';
  }

  authorizationUrl(request: AuthorizationRequest): string {
    if (!this.options.authorizeUrl) {
      throw new Error('The fake OAuth page is not configured here; only the API starts authorizations.');
    }
    const url = new URL(this.options.authorizeUrl);
    url.searchParams.set('platform', this.platform);
    url.searchParams.set('state', request.state);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('scope', this.scopes.join(' '));
    if (request.codeChallenge) {
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthGrant> {
    const code = decodeMockCode(input.code);
    const now = this.options.clock.now().getTime();
    const invalid = (): Promise<never> =>
      Promise.reject(
        new PlatformError('VALIDATION_REJECTED', 'The code exchange was refused (invalid_grant)', {
          status: 400,
        }),
      );
    if (!code || code.platform !== this.platform || code.expiresAt < now) {
      return invalid();
    }
    if (
      this.usesPkce &&
      (!code.challenge || !input.codeVerifier || pkceChallengeOf(input.codeVerifier) !== code.challenge)
    ) {
      return invalid();
    }
    return Promise.resolve({
      ...this.tokens(now, code.scopes),
      externalUserId: code.user,
      displayName: `Mock ${code.user}`,
    });
  }

  listConnectableAccounts(grant: OAuthGrant): Promise<ConnectableAccount[]> {
    const user = grant.externalUserId;
    const base = { handle: null, avatarUrl: null, accessToken: null };
    const accounts: Record<Platform, ConnectableAccount[]> = {
      LINKEDIN: [
        { ...base, externalId: `urn:li:person:${user}`, type: 'PROFILE', name: grant.displayName },
        {
          ...base,
          externalId: `urn:li:organization:${user}-1001`,
          type: 'PAGE',
          name: 'Nordlicht Haustechnik',
        },
        { ...base, externalId: `urn:li:organization:${user}-1002`, type: 'PAGE', name: 'Nordlicht Karriere' },
      ],
      FACEBOOK: [
        {
          ...base,
          externalId: `${user}-page-1`,
          type: 'PAGE',
          name: 'Nordlicht Haustechnik',
          accessToken: token('page'),
        },
        {
          ...base,
          externalId: `${user}-page-2`,
          type: 'PAGE',
          name: 'Nordlicht Service',
          accessToken: token('page'),
        },
      ],
      INSTAGRAM: [
        {
          ...base,
          externalId: `${user}-ig`,
          type: 'BUSINESS',
          name: 'nordlicht.haustechnik',
          handle: 'nordlicht.haustechnik',
        },
      ],
      X: [{ ...base, externalId: `${user}-x`, type: 'PROFILE', name: grant.displayName, handle: user }],
    };
    return Promise.resolve(accounts[this.platform]);
  }

  revoke(tokens: TokenSet): Promise<void> {
    return this.options.store.countCall('revoke', tokens.accessToken.slice(0, 12));
  }

  /** A fresh token set, as a refresh returns it. */
  tokens(now: number, scopes: readonly string[]): TokenSet {
    const lifetime = LIFETIMES[this.platform];
    // Like the real X, a refresh token only comes with offline.access.
    const refreshMs = this.platform === 'X' && !scopes.includes('offline.access') ? null : lifetime.refreshMs;
    return {
      accessToken: token('access'),
      refreshToken: refreshMs === null ? null : token('refresh'),
      accessTokenExpiresAt: new Date(now + lifetime.accessMs),
      refreshTokenExpiresAt: refreshMs === null ? null : new Date(now + refreshMs),
      scopes,
    };
  }
}
