import type {
  AuthorizationRequest,
  ConnectableAccount,
  OAuthConnector,
  OAuthGrant,
  TokenSet,
} from '@smp/core';

import { FACEBOOK_SCOPES, INSTAGRAM_SCOPES } from './meta-scopes';
import type { MetaLogin } from './meta-login';

// The OAuth connector of Instagram professional accounts through the Instagram API with Facebook
// Login: the user logs in with Facebook, and every Page with a linked Instagram account offers
// that account. Its credential is the Page token of the linked Page: the Content Publishing guide
// lists "Facebook Page access token" for this setup, and Page tokens from a long-lived user token
// do not expire by time. Checked 2026-11-25:
// https://developers.facebook.com/documentation/instagram-platform/content-publishing,
// https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/get-started
// Not settled by the docs: the endpoint references (media, media_publish, container) name a user
// access token instead; both are Facebook tokens of the same user and Page.
// Redirect URI of the local app: http://localhost:3000/api/oauth/instagram/callback, same rules as
// for Facebook (facebook-connector.ts).

export interface InstagramConnectorOptions {
  /** A Facebook Login for Business configuration with the Instagram permissions. */
  loginConfigId?: string;
  /** Overrides INSTAGRAM_SCOPES. */
  scopes?: readonly string[];
}

export class InstagramConnector implements OAuthConnector {
  readonly scopes: readonly string[];
  readonly usesPkce = false;

  constructor(
    private readonly login: MetaLogin,
    private readonly options: InstagramConnectorOptions = {},
  ) {
    this.scopes = options.scopes ?? INSTAGRAM_SCOPES;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    return this.login.dialogUrl(request, { scopes: this.scopes, configId: this.options.loginConfigId });
  }

  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthGrant> {
    return this.login.grantOf(input.code, input.redirectUri);
  }

  async listConnectableAccounts(grant: OAuthGrant): Promise<ConnectableAccount[]> {
    const pages = await this.login.pages(
      grant.accessToken,
      'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}',
    );
    const accounts: ConnectableAccount[] = [];
    for (const page of pages) {
      const instagram = page.instagram_business_account;
      if (instagram === undefined || page.access_token === undefined) {
        continue;
      }
      accounts.push({
        externalId: instagram.id,
        type: 'BUSINESS',
        name: instagram.name ?? instagram.username ?? page.name,
        handle: instagram.username ?? null,
        avatarUrl: instagram.profile_picture_url ?? null,
        accessToken: page.access_token,
      });
    }
    return accounts;
  }

  /** Removes the Instagram-only permissions; the Facebook connection keeps working. */
  revoke(tokens: TokenSet): Promise<void> {
    const shared = new Set<string>(FACEBOOK_SCOPES);
    return this.login.revokePermissions(
      tokens.accessToken,
      this.scopes.filter((scope) => !shared.has(scope)),
    );
  }
}
