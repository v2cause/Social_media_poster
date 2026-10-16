import type { Platform } from '@smp/platform-rules';

import type { ContentActor } from '../../content/domain/types';
import { NotPermittedError } from '../../shared/domain/errors';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import { PendingConnectionNotFoundError } from '../domain/errors';
import { canManageChannels } from '../domain/rules';
import type { ChannelScope, ChannelUnitOfWork } from '../ports/channel-store';
import type {
  ChannelConnectors,
  OAuthRandom,
  OAuthStateStore,
  PendingConnection,
  PendingConnectionStore,
} from '../ports/oauth';
import type { SecretSealer } from '../ports/secrets';

/** What the channel use cases need from the outside. */
export interface ChannelDependencies {
  unitOfWork: ChannelUnitOfWork;
  connectors: ChannelConnectors;
  states: OAuthStateStore;
  pendings: PendingConnectionStore;
  /** Seals with the token keyring. */
  sealer: SecretSealer;
  random: OAuthRandom;
  clock: Clock;
  ids: IdGenerator;
  /** The OAuth callback of the app for a platform, as registered with the platform app. */
  callbackUrl: (platform: Platform) => string;
}

export const channelScopeOf = (actor: ContentActor): ChannelScope => ({
  userId: actor.userId,
  organizationId: actor.organizationId,
  workspaceId: actor.workspaceId,
});

/** The second line behind the permission guard of the API. */
export function assertCanManageChannels(actor: ContentActor): void {
  if (!canManageChannels(actor.role)) {
    throw new NotPermittedError();
  }
}

/** A pending connection of the actor that has not expired; anything else counts as unknown. */
export async function pendingOf(
  deps: Pick<ChannelDependencies, 'pendings' | 'clock'>,
  actor: ContentActor,
  pendingId: string,
): Promise<PendingConnection> {
  const pending = await deps.pendings.find(pendingId);
  if (
    !pending ||
    pending.workspaceId !== actor.workspaceId ||
    pending.userId !== actor.userId ||
    pending.expiresAt <= deps.clock.now()
  ) {
    throw new PendingConnectionNotFoundError();
  }
  return pending;
}
