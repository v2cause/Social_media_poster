import type {
  AuthorizationRequest,
  ConnectableAccount,
  OAuthConnector,
  OAuthGrant,
  TokenSet,
} from '@smp/core';

import { FACEBOOK_SCOPES, INSTAGRAM_SCOPES } from './meta-scopes';
import type { MetaLogin } from './meta-login';

// The OAuth connector of Facebook Pages (guide step 4.13): Facebook Login (for Business), then the
// Pages the user can publish to, each with its own Page token. Redirect URI of the local app:
// http://localhost:3000/api/oauth/facebook/callback. Meta allows HTTP only for localhost and only
// while the app is in development mode ("You will still be able to use HTTP with 'localhost'
// addresses, but only while your app is still in development mode"; checked 2026-11-25:
// https://developers.facebook.com/blog/post/2018/06/08/enforce-https-facebook-login/). With Strict
// Mode the URI must match an entry of "Valid OAuth redirect URIs" exactly (checked 2026-11-25:
// https://developers.facebook.com/documentation/facebook-login/security).

export interface FacebookConnectorOptions {
  /** A Facebook Login for Business configuration with the permissions below. */
  loginConfigId?: string;
  /** Overrides FACEBOOK_SCOPES, for example to add business_management. */
  scopes?: readonly string[];
}

/** Tasks that allow publishing as the Page (checked 2026-11-25, Page feed reference). */
const PUBLISHING_TASKS = new Set(['CREATE_CONTENT', 'MANAGE']);

export class FacebookConnector implements OAuthConnector {
  readonly scopes: readonly string[];
  readonly usesPkce = false;

  constructor(
    private readonly login: MetaLogin,
    private readonly options: FacebookConnectorOptions = {},
  ) {
    this.scopes = options.scopes ?? FACEBOOK_SCOPES;
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
    const pages = await this.login.pages(grant.accessToken, 'id,name,access_token,tasks,picture{url}');
    return pages
      .filter((page) => page.access_token !== undefined)
      .filter((page) => page.tasks === undefined || page.tasks.some((task) => PUBLISHING_TASKS.has(task)))
      .map((page) => ({
        externalId: page.id,
        type: 'PAGE',
        name: page.name,
        handle: null,
        avatarUrl: page.picture?.data?.url ?? null,
        accessToken: page.access_token ?? null,
      }));
  }

  /** Removes the Facebook-only permissions; the Instagram connection keeps working. */
  revoke(tokens: TokenSet): Promise<void> {
    const shared = new Set<string>(INSTAGRAM_SCOPES);
    return this.login.revokePermissions(
      tokens.accessToken,
      this.scopes.filter((scope) => !shared.has(scope)),
    );
  }
}
