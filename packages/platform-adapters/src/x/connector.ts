import type {
  AuthorizationRequest,
  ConnectableAccount,
  OAuthConnector,
  OAuthGrant,
  TokenSet,
} from '@smp/core';

import type { PlatformHttpClient } from '../http/platform-http-client';
import { PLATFORM_SCOPES } from '../scopes';
import { basicAuthOf, type ResolvedXConfig } from './x-config';
import { mapXApiError, mapXTokenError } from './x-errors';
import { tokenResponseSchema, usersMeSchema, type XTokenResponse, type XUsersMe } from './x-schemas';

// OAuth 2.0 Authorization Code Flow with PKCE (S256) of X for a confidential client (guide step
// 4.14, architecture 4.2). Checked 2026-11-25 against
// https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token and
// https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code:
// - authorize: https://x.com/i/oauth2/authorize with response_type=code, client_id, redirect_uri
//   (exact match with a callback URL of the app), scope, state (up to 500 characters),
//   code_challenge and code_challenge_method (S256 or plain; S256 is the only method the server
//   metadata lists, https://docs.x.com/tools/mcp);
// - token: POST https://api.x.com/2/oauth2/token, application/x-www-form-urlencoded, with code,
//   grant_type=authorization_code, redirect_uri and code_verifier; a confidential client
//   authenticates with HTTP Basic instead of sending client_id. The code is valid for 30 seconds;
// - the access token lives 2 hours; a refresh token comes only with offline.access, lives about
//   6 months and is single-use (https://docs.x.com/fundamentals/authentication/oauth-2-0/
//   oauth-1-0a-token-exchange, "Refresh access tokens");
// - revoke: POST https://api.x.com/2/oauth2/revoke with token, HTTP Basic for confidential
//   clients. X keeps one live grant per user and app: a new consent invalidates the previous
//   tokens (same page, "Re-running and retries").

/**
 * The scopes of architecture 4.2. POST /2/tweets and DELETE /2/tweets/:id need tweet.read,
 * tweet.write and users.read; the media endpoints media.write; GET /2/users/me users.read and
 * tweet.read (security of each operation in https://docs.x.com/openapi.json 2.175, checked
 * 2026-11-25); offline.access brings the refresh token.
 */
export const X_SCOPES: readonly string[] = PLATFORM_SCOPES.X;

/** The refresh token lives "about 6 months"; X does not return its expiry. */
const REFRESH_TOKEN_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;
/** The access token lives 2 hours when expires_in is missing. */
const DEFAULT_ACCESS_TOKEN_SECONDS = 7200;

const USER_FIELDS = 'id,name,username,profile_image_url';

interface Profile {
  username: string;
  avatarUrl: string | null;
}

/** The token set of a token answer, at the time of the answer. */
export function tokenSetOf(answer: XTokenResponse, now: Date): TokenSet {
  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? null,
    accessTokenExpiresAt: new Date(
      now.getTime() + (answer.expires_in ?? DEFAULT_ACCESS_TOKEN_SECONDS) * 1000,
    ),
    refreshTokenExpiresAt:
      answer.refresh_token === undefined ? null : new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
    scopes: (answer.scope ?? '').split(/\s+/).filter((scope) => scope.length > 0),
  };
}

// Percent-encoding with %20 for spaces, as in the examples of the docs; URLSearchParams would
// write "+".
const query = (params: Readonly<Record<string, string>>): string =>
  Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

export class XOAuthConnector implements OAuthConnector {
  readonly scopes = X_SCOPES;
  readonly usesPkce = true;
  // The profile read during the code exchange, so the account list right after it needs no
  // second paid read of the user (User: Read costs $0.010).
  private readonly profiles = new WeakMap<OAuthGrant, Profile>();

  constructor(
    private readonly config: ResolvedXConfig,
    private readonly http: PlatformHttpClient,
  ) {}

  authorizationUrl(request: AuthorizationRequest): string {
    if (!request.codeChallenge) {
      throw new Error('X requires PKCE: the authorization needs a code challenge.');
    }
    return `${this.config.authorizeUrl}?${query({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: request.redirectUri,
      scope: this.scopes.join(' '),
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
    })}`;
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthGrant> {
    if (!input.codeVerifier) {
      throw new Error('X requires PKCE: the code exchange needs the code verifier.');
    }
    const now = () => this.config.clock.now().getTime();
    const { data } = await this.http.request({
      operation: 'x.oauth.token',
      method: 'POST',
      url: `${this.config.apiBaseUrl}/2/oauth2/token`,
      headers: { authorization: basicAuthOf(this.config) },
      body: {
        form: {
          code: input.code,
          grant_type: 'authorization_code',
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        },
      },
      schema: tokenResponseSchema,
      // A code works once: repeating the call after a lost answer cannot succeed either.
      idempotent: true,
      mapError: mapXTokenError('x.oauth.token', now, 'VALIDATION_REJECTED'),
    });
    const tokens = tokenSetOf(data, this.config.clock.now());
    const me = await this.me(tokens.accessToken);
    const grant: OAuthGrant = { ...tokens, externalUserId: me.data.id, displayName: me.data.name };
    this.profiles.set(grant, {
      username: me.data.username,
      avatarUrl: me.data.profile_image_url ?? null,
    });
    return grant;
  }

  async listConnectableAccounts(grant: OAuthGrant): Promise<ConnectableAccount[]> {
    let profile = this.profiles.get(grant);
    let name = grant.displayName;
    let externalId = grant.externalUserId;
    if (!profile) {
      const me = await this.me(grant.accessToken);
      profile = { username: me.data.username, avatarUrl: me.data.profile_image_url ?? null };
      name = me.data.name;
      externalId = me.data.id;
    }
    return [
      {
        externalId,
        type: 'PROFILE',
        name,
        handle: profile.username,
        avatarUrl: profile.avatarUrl,
        accessToken: null,
      },
    ];
  }

  /** Revokes the refresh token, which ends the grant, and the access token. */
  async revoke(tokens: TokenSet): Promise<void> {
    const now = () => this.config.clock.now().getTime();
    const revocable = [tokens.refreshToken, tokens.accessToken].filter(
      (token): token is string => token !== null && token.length > 0,
    );
    for (const token of revocable) {
      await this.http.request({
        operation: 'x.oauth.revoke',
        method: 'POST',
        url: `${this.config.apiBaseUrl}/2/oauth2/revoke`,
        headers: { authorization: basicAuthOf(this.config) },
        body: { form: { token } },
        idempotent: true,
        mapError: mapXTokenError('x.oauth.revoke', now, 'VALIDATION_REJECTED'),
      });
    }
  }

  /** GET /2/users/me: the user who granted the tokens. */
  private async me(accessToken: string): Promise<XUsersMe> {
    const now = () => this.config.clock.now().getTime();
    const { data } = await this.http.request({
      operation: 'x.users.me',
      method: 'GET',
      url: `${this.config.apiBaseUrl}/2/users/me?${query({ 'user.fields': USER_FIELDS })}`,
      headers: { authorization: `Bearer ${accessToken}` },
      schema: usersMeSchema,
      mapError: mapXApiError('x.users.me', now),
    });
    return data;
  }
}
