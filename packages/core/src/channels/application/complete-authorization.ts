import type { Platform } from '@smp/platform-rules';

import { pendingSecretAad } from '../domain/secrets';
import { PENDING_CONNECTION_TTL_MS } from '../domain/rules';
import type { ConnectableAccountView } from '../ports/oauth';
import type { ConnectableAccount, OAuthGrant } from '../ports/platform-adapter';
import type { ChannelDependencies } from './dependencies';
import { pendingSecretsOf } from './pending-secrets';

// The OAuth callback (guide step 4.5). The state is taken once; it must belong to the user of the
// session, so a callback someone else started is refused. The code exchange runs on the server
// with the PKCE verifier of the state. The grant is not stored yet: its tokens are sealed and
// parked for 15 minutes until the user picks the accounts to connect.

export const AUTHORIZATION_FAILURES = [
  'STATE_INVALID',
  'USER_MISMATCH',
  'ACCESS_DENIED',
  'PROVIDER_ERROR',
  'EXCHANGE_FAILED',
  'CHANNEL_UNAVAILABLE',
] as const;
export type AuthorizationFailure = (typeof AUTHORIZATION_FAILURES)[number];

/**
 * The error values of a refused consent: access_denied of RFC 6749, and LinkedIn's own for a
 * cancelled sign-in or authorization.
 */
const DENIALS: readonly string[] = ['access_denied', 'user_cancelled_login', 'user_cancelled_authorize'];

export interface CompleteAuthorizationInput {
  /** The user of the session the browser came back with. */
  userId: string;
  /** The platform of the callback path; it must be the one the state was made for. */
  platform: Platform;
  state: string;
  code: string | null;
  /** The error parameter of the callback, for example access_denied. */
  error: string | null;
}

export type AuthorizationOutcome =
  | { status: 'pending'; workspaceSlug: string; pendingId: string }
  | {
      status: 'failed';
      reason: AuthorizationFailure;
      /** Null when the state is unknown, so the workspace is too. */
      workspaceSlug: string | null;
      /** The error of the platform, for the log. */
      cause?: unknown;
    };

const failed = (
  reason: AuthorizationFailure,
  workspaceSlug: string | null,
  cause?: unknown,
): AuthorizationOutcome => ({
  status: 'failed',
  reason,
  workspaceSlug,
  ...(cause === undefined ? {} : { cause }),
});

const viewOf = (account: ConnectableAccount): ConnectableAccountView => ({
  externalId: account.externalId,
  type: account.type,
  name: account.name,
  handle: account.handle,
  avatarUrl: account.avatarUrl,
});

export class CompleteAuthorization {
  constructor(
    private readonly deps: Pick<
      ChannelDependencies,
      'connectors' | 'states' | 'pendings' | 'sealer' | 'random' | 'clock'
    >,
  ) {}

  async execute(input: CompleteAuthorizationInput): Promise<AuthorizationOutcome> {
    const state = await this.deps.states.take(input.state);
    if (!state) {
      return failed('STATE_INVALID', null);
    }
    const slug = state.workspaceSlug;
    if (state.platform !== input.platform) {
      return failed('STATE_INVALID', slug);
    }
    if (state.userId !== input.userId) {
      return failed('USER_MISMATCH', slug);
    }
    if (input.error !== null) {
      return failed(DENIALS.includes(input.error) ? 'ACCESS_DENIED' : 'PROVIDER_ERROR', slug);
    }
    if (input.code === null) {
      return failed('PROVIDER_ERROR', slug);
    }
    const connector = this.deps.connectors.connector(state.platform, state.method);
    if (!connector) {
      return failed('CHANNEL_UNAVAILABLE', slug);
    }

    let grant: OAuthGrant;
    let accounts: ConnectableAccount[];
    try {
      grant = await connector.exchangeCode({
        code: input.code,
        redirectUri: state.redirectUri,
        codeVerifier: state.codeVerifier,
      });
      accounts = await connector.listConnectableAccounts(grant);
    } catch (cause) {
      return failed('EXCHANGE_FAILED', slug, cause);
    }

    const id = this.deps.random.token();
    await this.deps.pendings.save({
      id,
      userId: state.userId,
      organizationId: state.organizationId,
      workspaceId: state.workspaceId,
      platform: state.platform,
      method: state.method,
      externalUserId: grant.externalUserId,
      displayName: grant.displayName,
      requestedScopes: [...connector.scopes],
      grantedScopes: [...grant.scopes],
      accounts: accounts.map(viewOf),
      sealedSecrets: await this.deps.sealer.seal(
        pendingSecretsOf(grant, accounts),
        pendingSecretAad(state.workspaceId, id),
      ),
      reconnectAccountId: state.reconnectAccountId,
      expiresAt: new Date(this.deps.clock.now().getTime() + PENDING_CONNECTION_TTL_MS),
    });
    return { status: 'pending', workspaceSlug: slug, pendingId: id };
  }
}
