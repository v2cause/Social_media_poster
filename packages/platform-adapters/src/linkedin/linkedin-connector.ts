import {
  isPlatformError,
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
import {
  LINKEDIN_API_URL,
  LINKEDIN_OAUTH_URL,
  restHeaders,
  tokenAnswerSchema,
  type LinkedInAppConfig,
} from './linkedin-api';

// The OAuth side of LinkedIn (guide step 4.12, architecture 4.2): the 3-legged flow without PKCE,
// the person from the OpenID userinfo (urn:li:person:{sub}) and, with the Community Management
// API, the company pages the person administers. Tokens live 60 days; only partners get refresh
// tokens, so without one the user connects again in time (token monitor).

/** The roles on a company page that may post for it. */
const POSTING_ROLES = new Set(['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR']);
/** The most company pages offered for one grant. */
const MAX_ORGANIZATIONS = 50;

const MEMBER_SCOPES = ['openid', 'profile', 'w_member_social'] as const;
const ORGANIZATION_SCOPES = [
  'w_organization_social',
  'r_organization_social',
  'rw_organization_admin',
] as const;

/** The scopes the app asks for: the member always, analytics and pages where the app has them. */
export const linkedInScopes = (
  config: Pick<LinkedInAppConfig, 'organizations' | 'memberAnalytics'>,
): string[] => [
  ...MEMBER_SCOPES,
  ...(config.memberAnalytics ? ['r_member_postAnalytics'] : []),
  ...(config.organizations ? ORGANIZATION_SCOPES : []),
];

const userinfoSchema = z.object({
  sub: z.string().min(1),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
});

const aclsSchema = z.object({
  elements: z.array(
    z
      .object({
        organization: z.string().optional(),
        organizationTarget: z.string().optional(),
        role: z.string(),
        state: z.string().optional(),
      })
      .loose(),
  ),
});

const organizationSchema = z
  .object({
    id: z.number().or(z.string()).optional(),
    localizedName: z.string().optional(),
    vanityName: z.string().optional(),
  })
  .loose();

export class LinkedInConnector implements OAuthConnector {
  readonly scopes: readonly string[];
  readonly usesPkce = false;

  constructor(
    private readonly config: LinkedInAppConfig,
    private readonly http: PlatformHttpClient,
    private readonly clock: Clock,
  ) {
    this.scopes = linkedInScopes(config);
  }

  authorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(`${LINKEDIN_OAUTH_URL}/authorization`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('state', request.state);
    url.searchParams.set('scope', this.scopes.join(' '));
    return url.toString();
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthGrant> {
    const { data } = await this.http.request({
      operation: 'linkedin.oauth.token',
      method: 'POST',
      url: `${LINKEDIN_OAUTH_URL}/accessToken`,
      body: {
        form: {
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: input.redirectUri,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        },
      },
      schema: tokenAnswerSchema,
      idempotent: true,
    });
    const tokens = this.tokenSetOf(data);
    const { data: user } = await this.http.request({
      operation: 'linkedin.userinfo',
      method: 'GET',
      url: `${LINKEDIN_API_URL}/v2/userinfo`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      schema: userinfoSchema,
    });
    const name = user.name ?? [user.given_name, user.family_name].filter(Boolean).join(' ');
    return { ...tokens, externalUserId: user.sub, displayName: name.length > 0 ? name : 'LinkedIn' };
  }

  async listConnectableAccounts(grant: OAuthGrant): Promise<ConnectableAccount[]> {
    const accounts: ConnectableAccount[] = [
      {
        externalId: `urn:li:person:${grant.externalUserId}`,
        type: 'PROFILE',
        name: grant.displayName,
        handle: null,
        // The picture URLs of LinkedIn expire, so none is kept.
        avatarUrl: null,
        accessToken: null,
      },
    ];
    if (!this.config.organizations || !grant.scopes.includes('w_organization_social')) {
      return accounts;
    }
    return [...accounts, ...(await this.organizationsOf(grant.accessToken))];
  }

  async revoke(tokens: TokenSet): Promise<void> {
    await this.http.request({
      operation: 'linkedin.oauth.revoke',
      method: 'POST',
      url: `${LINKEDIN_OAUTH_URL}/revoke`,
      body: {
        form: {
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          token: tokens.accessToken,
        },
      },
      idempotent: true,
    });
  }

  /** A new token set from a refresh token, for the apps LinkedIn gave refresh tokens. */
  async refresh(refreshToken: string): Promise<TokenSet> {
    const { data } = await this.http.request({
      operation: 'linkedin.oauth.refresh',
      method: 'POST',
      url: `${LINKEDIN_OAUTH_URL}/accessToken`,
      body: {
        form: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        },
      },
      schema: tokenAnswerSchema,
      idempotent: true,
      // An invalid or expired refresh token is answered with 400 invalid_grant.
      mapError: (response) =>
        response.status === 400 || response.status === 401
          ? new PlatformError('AUTH_EXPIRED', 'linkedin.oauth.refresh was refused', {
              status: response.status,
            })
          : undefined,
    });
    return this.tokenSetOf(data);
  }

  private tokenSetOf(data: z.infer<typeof tokenAnswerSchema>): TokenSet {
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      accessTokenExpiresAt: expiryOf(this.clock, data.expires_in),
      refreshTokenExpiresAt: data.refresh_token ? expiryOf(this.clock, data.refresh_token_expires_in) : null,
      scopes: scopesOf(data.scope, this.scopes),
    };
  }

  /**
   * The company pages the person may post for. Without the Community Management API LinkedIn
   * refuses the call; then only the profile is offered.
   */
  private async organizationsOf(accessToken: string): Promise<ConnectableAccount[]> {
    const headers = restHeaders(accessToken, this.config.version);
    let urns: string[];
    try {
      const { data } = await this.http.request({
        operation: 'linkedin.organization_acls',
        method: 'GET',
        url: `${LINKEDIN_API_URL}/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100`,
        headers,
        schema: aclsSchema,
      });
      urns = [
        ...new Set(
          data.elements
            .filter((acl) => POSTING_ROLES.has(acl.role))
            .map((acl) => acl.organization ?? acl.organizationTarget)
            .filter((urn): urn is string => urn?.startsWith('urn:li:organization:') === true),
        ),
      ].slice(0, MAX_ORGANIZATIONS);
    } catch (error) {
      if (isPlatformError(error) && error.code === 'PERMISSION_DENIED') {
        return [];
      }
      throw error;
    }
    const accounts: ConnectableAccount[] = [];
    for (const urn of urns) {
      const id = urn.slice('urn:li:organization:'.length);
      const { data } = await this.http.request({
        operation: 'linkedin.organization',
        method: 'GET',
        url: `${LINKEDIN_API_URL}/rest/organizations/${encodeURIComponent(id)}`,
        headers,
        schema: organizationSchema,
      });
      accounts.push({
        externalId: urn,
        type: 'PAGE',
        name: data.localizedName ?? data.vanityName ?? urn,
        handle: data.vanityName ?? null,
        avatarUrl: null,
        accessToken: null,
      });
    }
    return accounts;
  }
}
