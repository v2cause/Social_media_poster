import { PlatformError, type AuthorizationRequest, type OAuthGrant } from '@smp/core';
import { z } from 'zod';

import type { GraphApi } from './graph-api';
import { META_DIALOG_HOST } from './graph-config';

// The OAuth side shared by the Facebook and the Instagram connector: Facebook Login (for
// Business), manual flow with the authorization code. Sources, checked 2026-11-25:
// - Dialog and code exchange:
//   https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow
// - Long-lived tokens ("A long-lived token generally lasts about 60 days"; Page tokens from a
//   long-lived user token "do not have an expiration date"):
//   https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived
// - config_id instead of scope:
//   https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business
// - DELETE /{user-id}/permissions with a permission parameter:
//   https://developers.facebook.com/docs/graph-api/reference/user/permissions/

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
});

const meSchema = z.object({ id: z.string().min(1), name: z.string().optional() });

const permissionsSchema = z.object({
  data: z.array(z.object({ permission: z.string(), status: z.string() })),
});

const pagingSchema = z
  .object({
    cursors: z.object({ after: z.string().optional() }).optional(),
    next: z.string().optional(),
  })
  .optional();

const pictureSchema = z.object({ data: z.object({ url: z.string().optional() }).optional() }).optional();

/** A Page from GET /me/accounts, with its Page token and, if linked, its Instagram account. */
const pageSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  access_token: z.string().min(1).optional(),
  tasks: z.array(z.string()).optional(),
  picture: pictureSchema,
  instagram_business_account: z
    .object({
      id: z.string().min(1),
      username: z.string().optional(),
      name: z.string().optional(),
      profile_picture_url: z.string().optional(),
    })
    .optional(),
});
export type ManagedPage = z.infer<typeof pageSchema>;

const pagesSchema = z.object({ data: z.array(pageSchema), paging: pagingSchema });

const successSchema = z.object({ success: z.boolean() });

/** At most 10 pages of 100 Pages each; nobody manages more from one app. */
const MAX_PAGE_REQUESTS = 10;

export interface LoginDialogOptions {
  scopes: readonly string[];
  /** A Facebook Login for Business configuration; replaces scope when set. */
  configId?: string;
}

export class MetaLogin {
  constructor(private readonly graph: GraphApi) {}

  /** The login dialog; auth_type=rerequest asks again for permissions declined earlier. */
  dialogUrl(request: AuthorizationRequest, options: LoginDialogOptions): string {
    const url = new URL(`${META_DIALOG_HOST}/${this.graph.graphVersion}/dialog/oauth`);
    url.searchParams.set('client_id', this.graph.appId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('state', request.state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('auth_type', 'rerequest');
    if (options.configId !== undefined) {
      url.searchParams.set('config_id', options.configId);
    } else {
      url.searchParams.set('scope', options.scopes.join(','));
    }
    return url.toString();
  }

  /**
   * Code, short-lived user token, long-lived user token, the user and the granted permissions.
   * The grant gets no expiry: the connector publishes with Page tokens, which do not expire by
   * time; a refused token (error 190) asks for a new login through the refresh path.
   */
  async grantOf(code: string, redirectUri: string): Promise<OAuthGrant> {
    const short = await this.graph.call({
      operation: 'meta.oauth.exchange_code',
      method: 'GET',
      path: '/oauth/access_token',
      query: { ...this.graph.appCredentials(), redirect_uri: redirectUri, code },
      schema: tokenSchema,
      // The code is single use; a second try fails anyway.
      idempotent: false,
    });
    const long = await this.graph.call({
      operation: 'meta.oauth.long_lived_token',
      method: 'GET',
      path: '/oauth/access_token',
      query: {
        ...this.graph.appCredentials(),
        grant_type: 'fb_exchange_token',
        fb_exchange_token: short.access_token,
      },
      schema: tokenSchema,
    });
    const token = long.access_token;
    const me = await this.graph.call({
      operation: 'meta.me',
      method: 'GET',
      path: '/me',
      token,
      query: { fields: 'id,name' },
      schema: meSchema,
    });
    const permissions = await this.graph.call({
      operation: 'meta.me.permissions',
      method: 'GET',
      path: '/me/permissions',
      token,
      schema: permissionsSchema,
    });
    return {
      accessToken: token,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scopes: permissions.data.filter((entry) => entry.status === 'granted').map((entry) => entry.permission),
      externalUserId: me.id,
      displayName: me.name ?? me.id,
    };
  }

  /** The Pages the user can act on, with Page tokens (long-lived, from a long-lived user token). */
  async pages(userToken: string, fields: string): Promise<ManagedPage[]> {
    const pages: ManagedPage[] = [];
    let after: string | undefined;
    for (let request = 0; request < MAX_PAGE_REQUESTS; request += 1) {
      const answer = await this.graph.call({
        operation: 'meta.me.accounts',
        method: 'GET',
        path: '/me/accounts',
        token: userToken,
        query: { fields, limit: '100', ...(after === undefined ? {} : { after }) },
        schema: pagesSchema,
      });
      pages.push(...answer.data);
      after = answer.paging?.cursors?.after;
      if (answer.paging?.next === undefined || after === undefined) {
        break;
      }
    }
    return pages;
  }

  /**
   * Removes the given permissions from the app. Facebook and Instagram share the Meta app and the
   * user, so each connector removes only the permissions the other one does not need.
   */
  async revokePermissions(userToken: string, permissions: readonly string[]): Promise<void> {
    for (const permission of permissions) {
      const answer = await this.graph.call({
        operation: 'meta.me.permissions.delete',
        method: 'DELETE',
        path: '/me/permissions',
        token: userToken,
        query: { permission },
        schema: successSchema,
      });
      if (!answer.success) {
        throw new PlatformError('TRANSIENT', 'meta.me.permissions.delete was not confirmed');
      }
    }
  }
}
