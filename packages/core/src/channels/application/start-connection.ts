import type { Platform } from '@smp/platform-rules';

import type { ContentActor } from '../../content/domain/types';
import { ChannelUnavailableError, SocialAccountNotFoundError } from '../domain/errors';
import { OAUTH_STATE_TTL_MS } from '../domain/rules';
import type { ConnectionMethod } from '../domain/types';
import { assertCanManageChannels, channelScopeOf, type ChannelDependencies } from './dependencies';

// The start of the OAuth flow (guide step 4.5): a state of 32 random bytes, bound to user,
// workspace and platform, valid for 10 minutes and once, plus the PKCE verifier where the
// platform uses PKCE. Reconnecting an account starts the same flow for its platform and method.

export type StartConnectionInput =
  | { actor: ContentActor; workspaceSlug: string; platform: Platform }
  | { actor: ContentActor; workspaceSlug: string; reconnectAccountId: string };

interface Target {
  platform: Platform;
  method: ConnectionMethod | null;
  reconnectAccountId: string | null;
}

export class StartConnection {
  constructor(
    private readonly deps: Pick<
      ChannelDependencies,
      'unitOfWork' | 'connectors' | 'states' | 'random' | 'callbackUrl'
    >,
  ) {}

  async execute(input: StartConnectionInput): Promise<{ authorizationUrl: string }> {
    const { actor } = input;
    assertCanManageChannels(actor);
    const target: Target =
      'reconnectAccountId' in input
        ? await this.reconnectTarget(actor, input.reconnectAccountId)
        : {
            platform: input.platform,
            method: this.deps.connectors.methodFor(input.platform),
            reconnectAccountId: null,
          };
    const { platform, method } = target;
    const connector = method === null ? null : this.deps.connectors.connector(platform, method);
    if (method === null || !connector) {
      throw new ChannelUnavailableError();
    }

    const state = this.deps.random.token();
    const pkce = connector.usesPkce ? this.deps.random.pkce() : null;
    const redirectUri = this.deps.callbackUrl(platform);
    await this.deps.states.save(
      state,
      {
        userId: actor.userId,
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        workspaceSlug: input.workspaceSlug,
        platform,
        method,
        redirectUri,
        codeVerifier: pkce?.verifier ?? null,
        reconnectAccountId: target.reconnectAccountId,
      },
      OAUTH_STATE_TTL_MS,
    );
    return {
      authorizationUrl: connector.authorizationUrl({
        state,
        redirectUri,
        codeChallenge: pkce?.challenge ?? null,
      }),
    };
  }

  /** The platform and method of a connected account; a reconnect never changes the method. */
  private reconnectTarget(actor: ContentActor, accountId: string): Promise<Target> {
    return this.deps.unitOfWork.run(channelScopeOf(actor), async (store) => {
      const account = await store.accounts.find(actor.workspaceId, accountId);
      const connection = account && (await store.connections.find(actor.workspaceId, account.connectionId));
      if (!account || account.disconnectedAt !== null || !connection) {
        throw new SocialAccountNotFoundError();
      }
      return { platform: account.platform, method: connection.method, reconnectAccountId: account.id };
    });
  }
}
