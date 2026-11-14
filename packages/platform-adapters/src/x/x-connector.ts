import {
  PlatformError,
  type AuthorizationRequest,
  type Clock,
  type ConnectableAccount,
  type OAuthConnector,
  type OAuthGrant,
  type TokenSet,
} from '@smp/core';
import { z } from 'zod';

import type { PlatformHttpClient } from '../http/platform-http-client';
import { expiryOf, scopesOf } from '../live/live-support';
import { PLATFORM_SCOPES } from '../scopes';
import { bearer, X_API_URL, X_AUTHORIZE_URL, type XAppConfig } from './x-api';

// The OAuth side of X (guide step 4.14, architecture 4.2): OAuth 2.0 with PKCE (S256). Access
// tokens live two hours; with offline.access a refresh token comes along, which is good for one
// use only: every refresh returns a new one, so refreshes run under the lock of the connection
// (ConnectionTokens). A confidential client authenticates with its secret (HTTP Basic).

const tokenSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive().optional(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
  })
  .loose();
const meSchema = z.object({
  data: z
    .object({
      id: z.string().min(1),
      name: z.string(),
      username: z.string(),
      profile_image_url: z.string().optional(),
    })
    .loose(),
});

/** X keeps a refresh token for six months after its last use (secondary sources). */
const REFRESH_TOKEN_DAYS = 180;

export class XConnector implements OAuthConnector {
  readonly scopes = PLATFORM_SCOPES.X;
  readonly usesPkce = true;

  constructor(
    private readonly config: XAppConfig,
    private readonly http: PlatformHttpClient,
    private readonly clock: Clock,
  ) {}

  authorizationUrl(request: AuthorizationRequest): string {
    if (!request.codeChallenge) {
      throw new Error('X needs a PKCE challenge.');
    }
    const url = new URL(X_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('scope', this.scopes.join(' '));
    url.searchParams.set('state', request.state);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthGrant> {
    if (!input.codeVerifier) {
      throw new PlatformError('VALIDATION_REJECTED', 'The code exchange of X needs the PKCE verifier');
    }
    const tokens = await this.token('x.oauth.token', {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    const me = await this.me(tokens.accessToken);
    return { ...tokens, externalUserId: me.id, displayName: me.name };
  }

  async listConnectableAccounts(grant: OAuthGrant): Promise<ConnectableAccount[]> {
    const me = await this.me(grant.accessToken);
    return [
      {
        externalId: me.id,
        type: 'PROFILE',
        name: me.name,
        handle: me.username,
        avatarUrl: me.profile_image_url ?? null,
        accessToken: null,
      },
    ];
  }

  async revoke(tokens: TokenSet): Promise<void> {
    const revoke = async (token: string, hint: string): Promise<void> => {
      await this.http.request({
        operation: 'x.oauth.revoke',
        method: 'POST',
        url: `${X_API_URL}/2/oauth2/revoke`,
        headers: this.clientAuth(),
        body: { form: { token, token_type_hint: hint, ...this.publicClientId() } },
        idempotent: true,
      });
    };
    if (tokens.refreshToken !== null) {
      await revoke(tokens.refreshToken, 'refresh_token');
    }
    await revoke(tokens.accessToken, 'access_token');
  }

  /** A new token set; the refresh token used is spent. */
  refresh(refreshToken: string): Promise<TokenSet> {
    return this.token(
      'x.oauth.refresh',
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      // A spent or revoked refresh token is answered with 400 invalid_request or invalid_grant.
      true,
    );
  }

  private async token(
    operation: string,
    form: Record<string, string>,
    refusalIsExpiry = false,
  ): Promise<TokenSet> {
    const { data } = await this.http.request({
      operation,
      method: 'POST',
      url: `${X_API_URL}/2/oauth2/token`,
      headers: this.clientAuth(),
      body: { form: { ...form, ...this.publicClientId() } },
      schema: tokenSchema,
      // A code or refresh token is spent by the first answer, so the call is not repeated blindly.
      idempotent: false,
      mapError: (response) =>
        refusalIsExpiry && (response.status === 400 || response.status === 401)
          ? new PlatformError('AUTH_EXPIRED', `${operation} was refused`, { status: response.status })
          : undefined,
    });
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      accessTokenExpiresAt: expiryOf(this.clock, data.expires_in),
      refreshTokenExpiresAt: data.refresh_token
        ? expiryOf(this.clock, REFRESH_TOKEN_DAYS * 24 * 60 * 60)
        : null,
      scopes: scopesOf(data.scope, this.scopes),
    };
  }

  private async me(accessToken: string): Promise<z.infer<typeof meSchema>['data']> {
    const { data } = await this.http.request({
      operation: 'x.users.me',
      method: 'GET',
      url: `${X_API_URL}/2/users/me?user.fields=profile_image_url`,
      headers: bearer(accessToken),
      schema: meSchema,
    });
    return data.data;
  }

  private clientAuth(): Record<string, string> {
    if (!this.config.clientSecret) {
      return {};
    }
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    return { authorization: `Basic ${credentials}` };
  }

  /** A public client names itself in the body; a confidential one through Basic auth. */
  private publicClientId(): Record<string, string> {
    return this.config.clientSecret ? {} : { client_id: this.config.clientId };
  }
}
