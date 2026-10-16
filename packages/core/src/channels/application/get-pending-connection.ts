import type { Platform } from '@smp/platform-rules';

import type { ContentActor } from '../../content/domain/types';
import { missingScopesOf } from '../domain/rules';
import type { ConnectionMethod } from '../domain/types';
import type { ConnectableAccountView } from '../ports/oauth';
import { assertCanManageChannels, channelScopeOf, pendingOf, type ChannelDependencies } from './dependencies';

// The consent waiting for the selection (guide step 4.5): the accounts it reaches, which of them
// are connected already, and the scopes the platform did not grant.

export interface PendingConnectionView {
  id: string;
  platform: Platform;
  method: ConnectionMethod;
  displayName: string;
  accounts: (ConnectableAccountView & { connected: boolean })[];
  grantedScopes: string[];
  missingScopes: string[];
  reconnectAccountId: string | null;
  expiresAt: Date;
}

export class GetPendingConnection {
  constructor(private readonly deps: Pick<ChannelDependencies, 'unitOfWork' | 'pendings' | 'clock'>) {}

  async execute(input: { actor: ContentActor; pendingId: string }): Promise<PendingConnectionView> {
    const { actor } = input;
    assertCanManageChannels(actor);
    const pending = await pendingOf(this.deps, actor, input.pendingId);
    const known = await this.deps.unitOfWork.run(channelScopeOf(actor), (store) =>
      store.accounts.findByExternalIds(
        actor.workspaceId,
        pending.platform,
        pending.accounts.map((account) => account.externalId),
      ),
    );
    const connected = new Set(
      known.filter((account) => account.disconnectedAt === null).map((account) => account.externalId),
    );

    return {
      id: pending.id,
      platform: pending.platform,
      method: pending.method,
      displayName: pending.displayName,
      accounts: pending.accounts.map((account) => ({
        ...account,
        connected: connected.has(account.externalId),
      })),
      grantedScopes: pending.grantedScopes,
      missingScopes: missingScopesOf(pending.requestedScopes, pending.grantedScopes),
      reconnectAccountId: pending.reconnectAccountId,
      expiresAt: pending.expiresAt,
    };
  }
}
