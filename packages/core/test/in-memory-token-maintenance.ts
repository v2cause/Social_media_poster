import type {
  ConnectedAccount,
  ExpiringConnection,
  OutboxEventInput,
  SocialConnection,
  TokenMaintenanceScope,
  TokenMaintenanceStore,
  TokenMaintenanceUnitOfWork,
} from '../src';
import { accessExpiryOf } from '../src';
import { ScopeViolation } from './in-memory-content';

// In-memory adapters for the token monitor and the token refresh: connections with the stage of
// their last reminder, their accounts, the scheduled variants that a new grant affects, and the
// outbox. Like row-level security, a unit of work sees one workspace only.

export interface MaintainedConnection extends SocialConnection {
  statusReason: string | null;
  expiryNoticeDays: number | null;
  lastRefreshedAt: Date | null;
}

interface State {
  connections: Map<string, MaintainedConnection>;
  accounts: Map<string, ConnectedAccount & { disconnectedAt: Date | null }>;
  /** Scheduled variants by id, with their account and mark. */
  variants: Map<string, { accountId: string; status: string; failureCode: string | null }>;
  outbox: (OutboxEventInput & { workspaceId: string })[];
}

export class InMemoryTokenMaintenance implements TokenMaintenanceUnitOfWork {
  state: State = { connections: new Map(), accounts: new Map(), variants: new Map(), outbox: [] };

  async run<T>(scope: TokenMaintenanceScope, work: (store: TokenMaintenanceStore) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.storeFor(scope));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  connection(id = 'connection-1'): MaintainedConnection {
    const connection = this.state.connections.get(id);
    if (!connection) {
      throw new Error(`no connection ${id}`);
    }
    return connection;
  }

  /** The scan of tick.tokens over the state. */
  expiring(until: Date): ExpiringConnection[] {
    return [...this.state.connections.values()].flatMap((connection): ExpiringConnection[] => {
      const expiry = accessExpiryOf({
        hasRefreshToken: connection.refreshTokenSealed !== null,
        accessTokenExpiresAt: connection.accessTokenExpiresAt,
        refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
      });
      if (
        expiry === null ||
        expiry > until ||
        !(connection.status === 'ACTIVE' || connection.status === 'EXPIRING')
      ) {
        return [];
      }
      return [
        {
          connectionId: connection.id,
          workspaceId: connection.workspaceId,
          organizationId: 'org-1',
          status: connection.status,
          method: connection.method,
          accessExpiresAt: expiry,
          expiryNoticeDays: connection.expiryNoticeDays,
        },
      ];
    });
  }

  private storeFor(scope: TokenMaintenanceScope): TokenMaintenanceStore {
    const state = (): State => this.state;
    const own = (workspaceId: string, id: string): MaintainedConnection | null => {
      if (workspaceId !== scope.workspaceId) {
        throw new ScopeViolation(`workspace ${workspaceId} is outside the scope`);
      }
      const connection = state().connections.get(id);
      return connection?.workspaceId === workspaceId ? connection : null;
    };
    return {
      connections: {
        find: (workspaceId, id) => Promise.resolve(structuredClone(own(workspaceId, id))),
        storeRefresh(workspaceId, id, version, tokens) {
          const connection = own(workspaceId, id);
          if (connection?.version !== version) {
            return Promise.resolve(false);
          }
          const { refreshedAt, ...rest } = tokens;
          state().connections.set(id, {
            ...connection,
            ...rest,
            lastRefreshedAt: refreshedAt,
            version: version + 1,
          });
          return Promise.resolve(true);
        },
        expiryNoticeOf: (workspaceId, id) => Promise.resolve(own(workspaceId, id)?.expiryNoticeDays ?? null),
        setExpiryStatus(workspaceId, id, status, resetNotices) {
          const connection = own(workspaceId, id);
          if (connection) {
            connection.status = status;
            connection.version += 1;
            if (resetNotices) {
              connection.expiryNoticeDays = null;
            }
          }
          return Promise.resolve();
        },
        noteExpiryNotice(workspaceId, id, stage, previous) {
          const connection = own(workspaceId, id);
          if (!connection || connection.expiryNoticeDays !== previous) {
            return Promise.resolve(false);
          }
          connection.expiryNoticeDays = stage;
          return Promise.resolve(true);
        },
        markNeedsReauth(workspaceId, id, reason) {
          const connection = own(workspaceId, id);
          if (connection?.status !== 'ACTIVE' && connection?.status !== 'EXPIRING') {
            return Promise.resolve({ changed: false, scheduledVariants: 0 });
          }
          connection.status = 'NEEDS_REAUTH';
          connection.statusReason = reason;
          connection.version += 1;
          const accounts = [...state().accounts.values()]
            .filter((row) => row.account.connectionId === id)
            .map((row) => row.account.id);
          let scheduledVariants = 0;
          for (const variant of state().variants.values()) {
            if (variant.status === 'SCHEDULED' && accounts.includes(variant.accountId)) {
              variant.failureCode = 'REAUTH_REQUIRED';
              scheduledVariants += 1;
            }
          }
          return Promise.resolve({ changed: true, scheduledVariants });
        },
      },
      accounts: {
        anyConnected(workspaceId, connectionId) {
          own(workspaceId, connectionId);
          const row = [...state().accounts.values()].find(
            (candidate) =>
              candidate.account.connectionId === connectionId && candidate.disconnectedAt === null,
          );
          return Promise.resolve(
            row ? structuredClone({ account: row.account, accessTokenSealed: row.accessTokenSealed }) : null,
          );
        },
      },
      outbox: {
        add(workspaceId, event) {
          if (workspaceId !== scope.workspaceId) {
            throw new ScopeViolation(`workspace ${workspaceId} is outside the scope`);
          }
          state().outbox.push({ ...event, workspaceId });
          return Promise.resolve();
        },
      },
    };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** An active LinkedIn connection of ws-1 without refresh token, its access running out in the given days. */
export function seedConnection(
  maintenance: InMemoryTokenMaintenance,
  now: number,
  overrides: Partial<MaintainedConnection> & { expiresInDays?: number } = {},
): MaintainedConnection {
  const { expiresInDays = 10, ...rest } = overrides;
  const connection: MaintainedConnection = {
    id: 'connection-1',
    workspaceId: 'ws-1',
    platform: 'LINKEDIN',
    method: 'API',
    status: 'ACTIVE',
    statusReason: null,
    externalUserId: 'user-1',
    displayName: 'Mira',
    accessTokenSealed: new TextEncoder().encode('ws-1:connection-1:access_token|access-1'),
    refreshTokenSealed: null,
    sessionSealed: null,
    accessTokenExpiresAt: new Date(now + expiresInDays * DAY_MS),
    refreshTokenExpiresAt: null,
    scopes: ['w_member_social'],
    version: 3,
    expiryNoticeDays: null,
    lastRefreshedAt: null,
    ...rest,
  };
  maintenance.state.connections.set(connection.id, connection);
  maintenance.state.accounts.set('account-1', {
    account: {
      id: 'account-1',
      workspaceId: 'ws-1',
      connectionId: connection.id,
      platform: connection.platform,
      type: 'PROFILE',
      externalId: 'urn:li:person:1',
      name: 'Mira',
      handle: null,
      settings: {},
    },
    accessTokenSealed: null,
    disconnectedAt: null,
  });
  return connection;
}
