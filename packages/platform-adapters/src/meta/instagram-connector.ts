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
import { expiryOf, scopesOf } from '../live/live-support';
import { PLATFORM_SCOPES } from '../scopes';
import { bearer, graphErrorOf, type InstagramAppConfig } from './graph-api';

// The OAuth side of Instagram (guide step 4.13, architecture 4.2): the Instagram API with
// Instagram Login for professional accounts. The code becomes a short-lived token (an hour), which
// is exchanged for a long-lived one (60 days) that the adapter renews before it ends. The token
// answer wraps its fields in "data" (Business Login for Instagram, read through its search
// excerpt on 2026-10-25); the older flat form is accepted too.

export const INSTAGRAM_GRAPH_URL = 'https://graph.instagram.com';

const tokenEntrySchema = z
  .object({
    access_token: z.string().min(1),
    user_id: z.union([z.string(), z.number()]).optional(),
    permissions: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .loose();
const codeAnswerSchema = z.union([z.object({ data: z.array(tokenEntrySchema).min(1) }), tokenEntrySchema]);
export const longLivedSchema = z
  .object({ access_token: z.string().min(1), expires_in: z.number().int().positive().optional() })
  .loose();
const meSchema = z
  .object({
    id: z.string().min(1),
    user_id: z.union([z.string(), z.number()]).optional(),
    username: z.string().optional(),
    name: z.string().optional(),
    profile_picture_url: z.string().optional(),
  })
  .loose();

/** The id the content publishing endpoints take: the professional account, else the app-scoped id. */
const accountIdOf = (me: z.infer<typeof meSchema>): string =>
  me.user_id === undefined ? me.id : String(me.user_id);

export class InstagramConnector implements OAuthConnector {
  readonly scopes = PLATFORM_SCOPES.INSTAGRAM;
  readonly usesPkce = false;

  constructor(
    private readonly config: InstagramAppConfig,
    private readonly http: PlatformHttpClient,
    private readonly clock: Clock,
  ) {}

  authorizationUrl(request: AuthorizationRequest): string {
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.scopes.join(','));
    url.searchParams.set('state', request.state);
    return url.toString();
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthGrant> {
    const { data: answer } = await this.http.request({
      operation: 'instagram.oauth.token',
      method: 'POST',
      url: 'https://api.instagram.com/oauth/access_token',
      body: {
        form: {
          client_id: this.config.appId,
          client_secret: this.config.appSecret,
          grant_type: 'authorization_code',
          redirect_uri: input.redirectUri,
          // Instagram appends #_ to the code in the redirect; the callback may keep it.
          code: input.code.replace(/#_$/, ''),
        },
      },
      schema: codeAnswerSchema,
      idempotent: true,
      mapError: graphErrorOf('instagram.oauth.token'),
    });
    const entry = 'access_token' in answer ? answer : answer.data[0];
    if (!entry) {
      throw new Error('The token answer of Instagram holds no entry.');
    }
    const query = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: this.config.appSecret,
      access_token: entry.access_token,
    });
    const { data: long } = await this.http.request({
      operation: 'instagram.oauth.long_lived',
      method: 'GET',
      url: `${INSTAGRAM_GRAPH_URL}/access_token?${query.toString()}`,
      schema: longLivedSchema,
      mapError: graphErrorOf('instagram.oauth.long_lived'),
    });
    const me = await this.me(long.access_token);
    return {
      accessToken: long.access_token,
      refreshToken: null,
      accessTokenExpiresAt: expiryOf(this.clock, long.expires_in),
      refreshTokenExpiresAt: null,
      scopes: scopesOf(entry.permissions, this.scopes),
      externalUserId: accountIdOf(me),
      displayName: me.name ?? me.username ?? 'Instagram',
    };
  }

  /** One professional account per Instagram login. */
  async listConnectableAccounts(grant: OAuthGrant): Promise<ConnectableAccount[]> {
    const me = await this.me(grant.accessToken);
    return [
      {
        externalId: accountIdOf(me),
        type: 'BUSINESS',
        name: me.name ?? me.username ?? 'Instagram',
        handle: me.username ?? null,
        avatarUrl: me.profile_picture_url ?? null,
        accessToken: null,
      },
    ];
  }

  /** Instagram Login offers no revocation by API; the user removes the app in Instagram. */
  revoke(): Promise<void> {
    return Promise.resolve();
  }

  private async me(accessToken: string): Promise<z.infer<typeof meSchema>> {
    const { data } = await this.http.request({
      operation: 'instagram.me',
      method: 'GET',
      url: `${INSTAGRAM_GRAPH_URL}/${this.config.graphVersion}/me?fields=id,user_id,username,name,profile_picture_url`,
      headers: bearer(accessToken),
      schema: meSchema,
      mapError: graphErrorOf('instagram.me'),
    });
    return data;
  }
}

/** For the refresh in the adapter: the same token set as after a code exchange. */
export const tokenSetOfLongLived = (
  clock: Clock,
  answer: z.infer<typeof longLivedSchema>,
  scopes: readonly string[],
): TokenSet => ({
  accessToken: answer.access_token,
  refreshToken: null,
  accessTokenExpiresAt: expiryOf(clock, answer.expires_in),
  refreshTokenExpiresAt: null,
  scopes: [...scopes],
});
