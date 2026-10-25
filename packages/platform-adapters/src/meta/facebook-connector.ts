import type {
  AuthorizationRequest,
  Clock,
  ConnectableAccount,
  OAuthConnector,
  OAuthGrant,
  TokenSet,
} from '@smp/core';
import { z } from 'zod';

import type { PlatformHttpClient } from '../http/platform-http-client';
import { PLATFORM_SCOPES } from '../scopes';
import { bearer, graphErrorOf, type MetaAppConfig } from './graph-api';

// The OAuth side of Facebook pages (guide step 4.13, architecture 4.2): Facebook Login (with a
// configuration of Facebook Login for Business where one is set), the short-lived user token
// exchanged for a long-lived one, and the pages of the user with their own page tokens. Page
// tokens of a long-lived user token do not expire, but the data access of the app ends 90 days
// after the user last granted it; the connection counts that as its end, so the token monitor
// asks for a new grant in time.

const DATA_ACCESS_DAYS = 90;

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().optional() }).loose();
const meSchema = z.object({ id: z.string().min(1), name: z.string().optional() });
const permissionsSchema = z.object({
  data: z.array(z.object({ permission: z.string(), status: z.string() })),
});
const pagesSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        name: z.string(),
        access_token: z.string().min(1).optional(),
        username: z.string().optional(),
        picture: z
          .object({ data: z.object({ url: z.string().optional() }).loose() })
          .loose()
          .optional(),
        tasks: z.array(z.string()).optional(),
      })
      .loose(),
  ),
});

export const graphUrl = (version: string, path: string): string =>
  `https://graph.facebook.com/${version}/${path}`;

export class FacebookConnector implements OAuthConnector {
  readonly scopes = PLATFORM_SCOPES.FACEBOOK;
  readonly usesPkce = false;

  constructor(
    private readonly config: MetaAppConfig,
    private readonly http: PlatformHttpClient,
    private readonly clock: Clock,
  ) {}

  authorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(`https://www.facebook.com/${this.config.graphVersion}/dialog/oauth`);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('state', request.state);
    url.searchParams.set('response_type', 'code');
    if (this.config.loginConfigId) {
      // Facebook Login for Business: the configuration names the permissions, not the scope.
      url.searchParams.set('config_id', this.config.loginConfigId);
    } else {
      url.searchParams.set('scope', this.scopes.join(','));
    }
    return url.toString();
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthGrant> {
    const { appId, appSecret, graphVersion } = this.config;
    const short = await this.token(
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: input.redirectUri,
        code: input.code,
      }),
      'facebook.oauth.token',
    );
    const long = await this.token(
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: short,
      }),
      'facebook.oauth.long_lived',
    );
    const { data: me } = await this.http.request({
      operation: 'facebook.me',
      method: 'GET',
      url: graphUrl(graphVersion, 'me?fields=id,name'),
      headers: bearer(long),
      schema: meSchema,
      mapError: graphErrorOf('facebook.me'),
    });
    const { data: permissions } = await this.http.request({
      operation: 'facebook.permissions',
      method: 'GET',
      url: graphUrl(graphVersion, 'me/permissions'),
      headers: bearer(long),
      schema: permissionsSchema,
      mapError: graphErrorOf('facebook.permissions'),
    });
    return {
      accessToken: long,
      refreshToken: null,
      accessTokenExpiresAt: new Date(this.clock.now().getTime() + DATA_ACCESS_DAYS * 24 * 60 * 60 * 1000),
      refreshTokenExpiresAt: null,
      scopes: permissions.data.filter((entry) => entry.status === 'granted').map((entry) => entry.permission),
      externalUserId: me.id,
      displayName: me.name ?? 'Facebook',
    };
  }

  /** The pages the user granted, each with its page token; pages without CREATE_CONTENT are left out. */
  async listConnectableAccounts(grant: OAuthGrant): Promise<ConnectableAccount[]> {
    const { data } = await this.http.request({
      operation: 'facebook.pages',
      method: 'GET',
      url: graphUrl(
        this.config.graphVersion,
        'me/accounts?fields=id,name,access_token,username,picture%7Burl%7D,tasks&limit=100',
      ),
      headers: bearer(grant.accessToken),
      schema: pagesSchema,
      mapError: graphErrorOf('facebook.pages'),
    });
    return data.data
      .filter((page) => page.access_token !== undefined)
      .filter((page) => page.tasks === undefined || page.tasks.includes('CREATE_CONTENT'))
      .map((page) => ({
        externalId: page.id,
        type: 'PAGE' as const,
        name: page.name,
        handle: page.username ?? null,
        avatarUrl: page.picture?.data.url ?? null,
        accessToken: page.access_token ?? null,
      }));
  }

  /** Removes the grant of the app for the user, and with it the page tokens. */
  async revoke(tokens: TokenSet): Promise<void> {
    await this.http.request({
      operation: 'facebook.permissions.revoke',
      method: 'DELETE',
      url: graphUrl(this.config.graphVersion, 'me/permissions'),
      headers: bearer(tokens.accessToken),
      mapError: graphErrorOf('facebook.permissions.revoke'),
    });
  }

  private async token(query: URLSearchParams, operation: string): Promise<string> {
    const { data } = await this.http.request({
      operation,
      method: 'GET',
      url: graphUrl(this.config.graphVersion, `oauth/access_token?${query.toString()}`),
      schema: tokenSchema,
      mapError: graphErrorOf(operation),
    });
    return data.access_token;
  }
}
