import type {
  AuthorizationRequest,
  Clock,
  ConnectableAccount,
  OAuthConnector,
  OAuthGrant,
  TokenSet,
} from '@smp/core';

import type { PlatformHttpClient } from '../http/platform-http-client';
import {
  LINKEDIN_AUTHORIZATION_URL,
  LINKEDIN_TOKEN_URL,
  LINKEDIN_USERINFO_URL,
  linkedInScopes,
  type LinkedInAppConfig,
} from './config';
import { mapRestError, mapTokenError } from './errors';
import { LinkedInApi } from './linkedin-api';
import { tokenResponseSchema, userinfoSchema, type TokenResponse, type Userinfo } from './schemas';

// The OAuth side of LinkedIn (guide step 4.12): the 3-legged authorization code flow with "Sign In
// with LinkedIn using OpenID Connect" (openid profile) and "Share on LinkedIn" (w_member_social),
// plus the scopes of the approved products. No PKCE: the documented flow authenticates the code
// exchange with the client secret and names no code_challenge parameter.
// https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
// https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
// (checked 2026-11-25)
// The person URN is urn:li:person:{sub} with sub from userinfo (guide step 4.12). The docs call sub
// the "Subject Identifier" and do not say in so many words that it is the person id of the REST
// APIs; that is the established use and to be confirmed with the first real post.

const ORGANIZATION_URN = /^urn:li:organization:(\d+)$/;

/** Splits the granted scopes: documented as space-delimited, comma-separated at the introspection. */
const scopesOf = (scope: string | undefined, requested: readonly string[]): string[] => {
  const granted = (scope ?? '').split(/[\s,]+/).filter((entry) => entry.length > 0);
  // The docs list scope as part of every token answer; without it, assume the requested ones.
  return granted.length > 0 ? granted : [...requested];
};

const displayNameOf = (user: Userinfo): string => {
  const name = user.name?.trim() ?? '';
  if (name.length > 0) {
    return name;
  }
  const parts = [user.given_name, user.family_name]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(' ') : 'LinkedIn member';
};

export class LinkedInOAuthConnector implements OAuthConnector {
  readonly scopes: readonly string[];
  readonly usesPkce = false;
  private readonly api: LinkedInApi;

  constructor(
    private readonly config: LinkedInAppConfig,
    private readonly http: PlatformHttpClient,
    private readonly clock: Clock,
  ) {
    this.scopes = linkedInScopes(config.features);
    this.api = new LinkedInApi(http, config.version);
  }

  /**
   * GET https://www.linkedin.com/oauth/v2/authorization with response_type=code, client_id,
   * redirect_uri, state and the space-delimited scope. The redirect URI must match one registered
   * in the app (Auth tab). A refused consent comes back with error=user_cancelled_login or
   * user_cancelled_authorize, which the callback treats as a denial.
   * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
   * (checked 2026-11-25)
   */
  authorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(LINKEDIN_AUTHORIZATION_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('state', request.state);
    url.searchParams.set('scope', this.scopes.join(' '));
    return url.toString();
  }

  /**
   * POST https://www.linkedin.com/oauth/v2/accessToken (form) with grant_type=authorization_code,
   * code, client_id, client_secret and the same redirect_uri. The code lives 30 minutes; access
   * tokens 60 days (expires_in); a refresh token only comes for apps approved for programmatic
   * refresh tokens.
   * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
   * (checked 2026-11-25)
   */
  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthGrant> {
    const response = await this.http.request({
      operation: 'linkedin.oauth.exchange_code',
      method: 'POST',
      url: LINKEDIN_TOKEN_URL,
      body: {
        form: {
          grant_type: 'authorization_code',
          code: input.code,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: input.redirectUri,
        },
      },
      schema: tokenResponseSchema,
      // A code is used once; repeating the exchange cannot create anything twice.
      idempotent: true,
      mapError: mapTokenError('linkedin.oauth.exchange_code', 'code'),
    });
    const tokens = this.tokenSetOf(response.data);
    const user = await this.userinfo(tokens.accessToken);
    return { ...tokens, externalUserId: user.sub, displayName: displayNameOf(user) };
  }

  /**
   * The personal profile, and with the organizations feature the pages the member administers
   * (role ADMINISTRATOR, state APPROVED). Only administrators are offered: share statistics and the
   * follower count of a page need that role, posting alone would also work for CONTENT_ADMIN.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
   * (checked 2026-11-25)
   */
  async listConnectableAccounts(grant: OAuthGrant): Promise<ConnectableAccount[]> {
    const user = await this.userinfo(grant.accessToken);
    const accounts: ConnectableAccount[] = [
      {
        externalId: `urn:li:person:${user.sub}`,
        type: 'PROFILE',
        name: displayNameOf(user),
        handle: null,
        avatarUrl: user.picture ?? null,
        accessToken: null,
      },
    ];
    if (this.config.features.organizations) {
      accounts.push(...(await this.organizationsOf(grant.accessToken)));
    }
    return accounts;
  }

  /**
   * LinkedIn documents no revocation endpoint for 3-legged member tokens; the member removes the
   * app in the LinkedIn privacy settings, and the token runs out after 60 days.
   * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
   * https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/error-handling
   * (checked 2026-11-25)
   */
  revoke(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * grant_type=refresh_token with client_id and client_secret, for apps with programmatic refresh
   * tokens (approved partners). The refresh token keeps its original end (365 days).
   * https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
   * (checked 2026-11-25)
   */
  async refresh(refreshToken: string, signal?: AbortSignal): Promise<TokenSet> {
    const response = await this.http.request({
      operation: 'linkedin.oauth.refresh',
      method: 'POST',
      url: LINKEDIN_TOKEN_URL,
      body: {
        form: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        },
      },
      schema: tokenResponseSchema,
      idempotent: true,
      mapError: mapTokenError('linkedin.oauth.refresh', 'refresh'),
      ...(signal ? { signal } : {}),
    });
    const tokens = this.tokenSetOf(response.data);
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  }

  private tokenSetOf(data: TokenResponse): TokenSet {
    const now = this.clock.now().getTime();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      accessTokenExpiresAt: new Date(now + data.expires_in * 1000),
      refreshTokenExpiresAt:
        data.refresh_token_expires_in === undefined
          ? null
          : new Date(now + data.refresh_token_expires_in * 1000),
      scopes: scopesOf(data.scope, this.scopes),
    };
  }

  /**
   * GET https://api.linkedin.com/v2/userinfo with the access token (unversioned, no LinkedIn-Version).
   * https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
   * (checked 2026-11-25)
   */
  private async userinfo(accessToken: string): Promise<Userinfo> {
    const response = await this.http.request({
      operation: 'linkedin.oauth.userinfo',
      method: 'GET',
      url: LINKEDIN_USERINFO_URL,
      headers: { authorization: `Bearer ${accessToken}` },
      schema: userinfoSchema,
      mapError: mapRestError('linkedin.oauth.userinfo'),
    });
    return response.data;
  }

  private async organizationsOf(token: string): Promise<ConnectableAccount[]> {
    const ids = new Set<string>();
    const pageSize = 100;
    // At most 500 pages; nobody administers more, and the loop stays bounded.
    for (let start = 0; start < 500; start += pageSize) {
      const elements = await this.api.administeredOrganizations({ token }, start, pageSize);
      for (const element of elements) {
        const urn = element.organization ?? element.organizationTarget ?? '';
        const id = ORGANIZATION_URN.exec(urn)?.[1];
        if (id !== undefined && (element.state ?? 'APPROVED') === 'APPROVED') {
          ids.add(id);
        }
      }
      if (elements.length < pageSize) {
        break;
      }
    }
    if (ids.size === 0) {
      return [];
    }
    const details = await this.api.organizations([...ids], { token });
    return [...ids].map((id) => {
      const organization = details[id];
      return {
        externalId: `urn:li:organization:${id}`,
        type: 'PAGE' as const,
        name: organization?.localizedName ?? `LinkedIn page ${id}`,
        handle: organization?.vanityName ?? null,
        avatarUrl: null,
        accessToken: null,
      };
    });
  }
}
