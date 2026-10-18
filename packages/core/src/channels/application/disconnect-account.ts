import type { ContentActor } from '../../content/domain/types';
import { SocialAccountNotFoundError } from '../domain/errors';
import { connectionSecretAad } from '../domain/secrets';
import type { SocialConnection } from '../domain/types';
import { assertCanManageChannels, channelScopeOf, type ChannelDependencies } from './dependencies';

// Disconnects an account (guide step 4.5, architecture 10). The account stays for the history of
// its posts, without its token. When no other account uses the connection any more, the grant is
// revoked at the platform and its tokens are dropped.

export interface DisconnectResult {
  /** skipped: other accounts still use the grant. failed: the platform did not confirm. */
  platformRevoke: 'done' | 'failed' | 'skipped';
  /** Why the revoke failed, for the log. */
  cause?: unknown;
}

export class DisconnectAccount {
  constructor(
    private readonly deps: Pick<ChannelDependencies, 'unitOfWork' | 'connectors' | 'sealer' | 'clock'>,
  ) {}

  async execute(input: { actor: ContentActor; accountId: string }): Promise<DisconnectResult> {
    const { actor } = input;
    assertCanManageChannels(actor);
    const workspaceId = actor.workspaceId;

    const revoked = await this.deps.unitOfWork.run(channelScopeOf(actor), async (store) => {
      const account = await store.accounts.find(workspaceId, input.accountId);
      if (!account || !(await store.accounts.disconnect(workspaceId, account.id, this.deps.clock.now()))) {
        throw new SocialAccountNotFoundError();
      }
      const last = (await store.accounts.connectedCount(workspaceId, account.connectionId)) === 0;
      const connection = last ? await store.connections.find(workspaceId, account.connectionId) : null;
      if (connection) {
        await store.connections.revoke(workspaceId, connection.id);
      }
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId,
        action: 'channel.disconnect',
        targetType: 'SocialAccount',
        targetId: account.id,
        metadata: { platform: account.platform, revoked: connection !== null },
      });
      return connection;
    });

    if (!revoked?.accessTokenSealed) {
      return { platformRevoke: 'skipped' };
    }
    // After the commit: the tokens are gone here even when the platform does not answer.
    try {
      await revokeAtPlatform(this.deps, revoked, revoked.accessTokenSealed);
      return { platformRevoke: 'done' };
    } catch (cause) {
      return { platformRevoke: 'failed', cause };
    }
  }
}

/**
 * Revokes the grant of a connection at its platform with its sealed tokens. Throws when the
 * platform does not confirm; also the erasure of an organization uses it (guide step 8.2).
 */
export async function revokeAtPlatform(
  deps: Pick<ChannelDependencies, 'connectors' | 'sealer'>,
  connection: SocialConnection,
  accessTokenSealed: Uint8Array,
): Promise<void> {
  const connector = deps.connectors.connector(connection.platform, connection.method);
  if (!connector) {
    throw new Error(`No connector for ${connection.platform} via ${connection.method}.`);
  }
  const aad = (field: 'access_token' | 'refresh_token') =>
    connectionSecretAad(connection.workspaceId, connection.id, field);
  await connector.revoke({
    accessToken: await deps.sealer.open(accessTokenSealed, aad('access_token')),
    refreshToken: connection.refreshTokenSealed
      ? await deps.sealer.open(connection.refreshTokenSealed, aad('refresh_token'))
      : null,
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
    scopes: connection.scopes,
  });
}
