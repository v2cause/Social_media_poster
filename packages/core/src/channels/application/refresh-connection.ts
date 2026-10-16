import type { Clock } from '../../shared/ports/clock';
import { accessExpiryOf } from '../domain/rules';
import { statusAfterRefresh } from '../domain/token-monitor';
import type { SocialConnection } from '../domain/types';
import type { AdapterContext, AdapterLogger } from '../ports/platform-adapter';
import type { SecretSealer } from '../ports/secrets';
import type {
  AdapterResolver,
  ConnectionLock,
  TokenMaintenanceScope,
  TokenMaintenanceUnitOfWork,
} from '../ports/token-maintenance';
import { ConnectionTokens, ReauthRequiredError } from './connection-tokens';

// token.refresh (guide step 4.9): renews the access of a connection that runs out within 14 days,
// under the lock of the connection. A platform that cannot renew it (LinkedIn without partner
// approval) leaves the connection EXPIRING, so tick.tokens reminds its managers. A refused
// refresh means a new grant: NEEDS_REAUTH, the scheduled variants are marked, and the managers
// hear of it.

export interface RefreshConnectionInput {
  organizationId: string;
  workspaceId: string;
  connectionId: string;
  signal?: AbortSignal;
}

/** refreshed: renewed; expiring: the access still runs out soon; reauth: a new grant is needed. */
export type RefreshConnectionOutcome = 'refreshed' | 'expiring' | 'unchanged' | 'reauth' | 'skipped';

export interface RefreshConnectionDependencies {
  unitOfWork: TokenMaintenanceUnitOfWork;
  adapters: AdapterResolver;
  sealer: SecretSealer;
  locks: ConnectionLock;
  clock: Clock;
  logger: AdapterLogger;
}

export class RefreshConnection {
  constructor(private readonly deps: RefreshConnectionDependencies) {}

  async execute(input: RefreshConnectionInput): Promise<RefreshConnectionOutcome> {
    const scope: TokenMaintenanceScope = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
    };
    const { connection, account } = await this.deps.unitOfWork.run(scope, async (store) => ({
      connection: await store.connections.find(input.workspaceId, input.connectionId),
      account: await store.accounts.anyConnected(input.workspaceId, input.connectionId),
    }));
    if (
      !connection ||
      !account ||
      connection.method === 'BROWSER' ||
      !(connection.status === 'ACTIVE' || connection.status === 'EXPIRING')
    ) {
      return 'skipped';
    }
    const adapter = await this.deps.adapters.resolve({
      platform: connection.platform,
      method: connection.method,
      workspaceId: input.workspaceId,
    });
    if (!adapter) {
      return 'skipped';
    }
    const tokens = new ConnectionTokens(
      this.deps,
      (work) => this.deps.unitOfWork.run(scope, (store) => work(store.connections)),
      account,
      connection,
      adapter,
    );
    const context = (): AdapterContext => ({
      account: account.account,
      credentials: tokens.credentials(),
      // A refresh costs nothing on any platform.
      costs: { record: () => Promise.resolve() },
      logger: this.deps.logger,
      signal: input.signal ?? new AbortController().signal,
      dryRun: false,
      keepAlive: () => Promise.resolve(),
    });

    let result;
    try {
      result = await tokens.refresh(context, true);
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        await this.requireReauth(scope, input.connectionId, error.reason);
        return 'reauth';
      }
      throw error;
    }
    const status = statusAfterRefresh(this.expiryOf(tokens.current), this.deps.clock.now());
    if (result === 'refreshed') {
      // A new expiry starts the reminders again.
      await this.deps.unitOfWork.run(scope, (store) =>
        store.connections.setExpiryStatus(input.workspaceId, input.connectionId, status, true),
      );
      return status === 'ACTIVE' ? 'refreshed' : 'expiring';
    }
    if (status === 'EXPIRING' && tokens.current.status !== 'EXPIRING') {
      await this.deps.unitOfWork.run(scope, (store) =>
        store.connections.setExpiryStatus(input.workspaceId, input.connectionId, 'EXPIRING', false),
      );
      return 'expiring';
    }
    return 'unchanged';
  }

  private expiryOf(connection: SocialConnection): Date | null {
    return accessExpiryOf({
      hasRefreshToken: connection.refreshTokenSealed !== null,
      accessTokenExpiresAt: connection.accessTokenExpiresAt,
      refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
    });
  }

  private requireReauth(scope: TokenMaintenanceScope, connectionId: string, reason: string): Promise<void> {
    return this.deps.unitOfWork.run(scope, async (store) => {
      const mark = await store.connections.markNeedsReauth(scope.workspaceId, connectionId, reason);
      if (mark.changed) {
        await store.outbox.add(scope.workspaceId, {
          type: 'notification.requested',
          payload: {
            type: 'reauth-required',
            connectionId,
            reason,
            scheduledVariants: mark.scheduledVariants,
          },
        });
      }
    });
  }
}
