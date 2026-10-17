import type { ContentActor } from '../../content/domain/types';
import { InvalidAccountSelectionError } from '../domain/errors';
import { missingScopesOf } from '../domain/rules';
import { accountSecretAad, connectionSecretAad, pendingSecretAad } from '../domain/secrets';
import type { ConnectionGrant } from '../ports/channel-store';
import { assertCanManageChannels, channelScopeOf, pendingOf, type ChannelDependencies } from './dependencies';
import { parsePendingSecrets } from './pending-secrets';

// Connects the accounts the user picked (guide step 4.5). A consent of the same platform user
// renews the existing connection; accounts connected before, also through another connection,
// are connected again. Every token is sealed anew with the AAD of its row.

export interface ConfirmConnectionInput {
  actor: ContentActor;
  pendingId: string;
  externalIds: readonly string[];
}

export interface ConfirmedConnection {
  connectionId: string;
  accountIds: string[];
}

export class ConfirmConnection {
  constructor(
    private readonly deps: Pick<ChannelDependencies, 'unitOfWork' | 'pendings' | 'sealer' | 'clock' | 'ids'>,
  ) {}

  async execute(input: ConfirmConnectionInput): Promise<ConfirmedConnection> {
    const { actor } = input;
    assertCanManageChannels(actor);
    const pending = await pendingOf(this.deps, actor, input.pendingId);
    const selected = [...new Set(input.externalIds)];
    const offered = new Map(pending.accounts.map((account) => [account.externalId, account]));
    if (selected.length === 0 || selected.some((externalId) => !offered.has(externalId))) {
      throw new InvalidAccountSelectionError();
    }
    const secrets = parsePendingSecrets(
      await this.deps.sealer.open(pending.sealedSecrets, pendingSecretAad(actor.workspaceId, pending.id)),
    );
    const { sealer } = this.deps;
    const workspaceId = actor.workspaceId;

    const confirmed = await this.deps.unitOfWork.run(channelScopeOf(actor), async (store) => {
      const existing = await store.connections.findByExternalUser(
        workspaceId,
        pending.platform,
        pending.method,
        pending.externalUserId,
      );
      const connectionId = existing?.id ?? this.deps.ids.newId();
      const grant: ConnectionGrant = {
        displayName: pending.displayName,
        accessTokenSealed: await sealer.seal(
          secrets.accessToken,
          connectionSecretAad(workspaceId, connectionId, 'access_token'),
        ),
        refreshTokenSealed:
          secrets.refreshToken === null
            ? null
            : await sealer.seal(
                secrets.refreshToken,
                connectionSecretAad(workspaceId, connectionId, 'refresh_token'),
              ),
        sessionSealed: null,
        accessTokenExpiresAt: dateOf(secrets.accessTokenExpiresAt),
        refreshTokenExpiresAt: dateOf(secrets.refreshTokenExpiresAt),
        scopes: pending.grantedScopes,
        connectedById: actor.userId,
        grantedAt: this.deps.clock.now(),
      };
      if (existing) {
        await store.connections.replaceGrant(workspaceId, connectionId, grant);
      } else {
        await store.connections.insert({
          id: connectionId,
          workspaceId,
          platform: pending.platform,
          method: pending.method,
          externalUserId: pending.externalUserId,
          ...grant,
        });
      }

      const known = new Map(
        (await store.accounts.findByExternalIds(workspaceId, pending.platform, selected)).map((account) => [
          account.externalId,
          account.id,
        ]),
      );
      const accountIds: string[] = [];
      for (const externalId of selected) {
        const account = offered.get(externalId);
        if (!account) {
          continue;
        }
        const id = known.get(externalId) ?? this.deps.ids.newId();
        const token = secrets.accounts[externalId];
        await store.accounts.upsert({
          id,
          workspaceId,
          connectionId,
          platform: pending.platform,
          type: account.type,
          externalId,
          name: account.name,
          handle: account.handle,
          avatarUrl: account.avatarUrl,
          accessTokenSealed:
            token === undefined
              ? null
              : await sealer.seal(token, accountSecretAad(workspaceId, connectionId, id)),
          connectedById: actor.userId,
        });
        accountIds.push(id);
      }

      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId,
        action: existing ? 'channel.reconnect' : 'channel.connect',
        targetType: 'SocialConnection',
        targetId: connectionId,
        metadata: {
          platform: pending.platform,
          method: pending.method,
          accounts: accountIds.length,
          missingScopes: missingScopesOf(pending.requestedScopes, pending.grantedScopes),
        },
      });
      return { connectionId, accountIds };
    });

    await this.deps.pendings.delete(pending.id);
    return confirmed;
  }
}

const dateOf = (value: string | null): Date | null => (value === null ? null : new Date(value));
