import type {
  AuditEntry,
  ChannelConnectors,
  ChannelDependencies,
  ChannelScope,
  ChannelStore,
  ChannelUnitOfWork,
  ConnectableAccount,
  ConnectionMethod,
  OAuthConnector,
  OAuthGrant,
  OAuthRandom,
  OAuthState,
  OAuthStateStore,
  PendingConnection,
  PendingConnectionStore,
  SecretSealer,
  SocialAccount,
  SocialConnection,
  TokenSet,
} from '../src';
import { PlanLimitReachedError, PlatformError, type AccountLimits } from '../src';
import { fixedClock, ScopeViolation, sequentialIds } from './in-memory-content';

// In-memory adapters for the channel use cases: a unit of work that hides other workspaces and
// rolls back on errors, the Redis stores of the OAuth flow, a sealer that binds the AAD, and a
// scriptable connector.

interface State {
  connections: Map<string, SocialConnection>;
  accounts: Map<string, SocialAccount>;
  /** SocialAccount.settings, which the domain type leaves out. */
  accountSettings: Map<string, Readonly<Record<string, string>>>;
  audit: AuditEntry[];
}

export class InMemoryChannels implements ChannelUnitOfWork {
  state: State = { connections: new Map(), accounts: new Map(), accountSettings: new Map(), audit: [] };

  async run<T>(scope: ChannelScope, work: (store: ChannelStore) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.storeFor(scope));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  private storeFor(scope: ChannelScope): ChannelStore {
    // The state is replaced on a rollback, so the repositories read it through this getter.
    const state = (): State => this.state;
    const assertScope = (workspaceId: string): void => {
      if (workspaceId !== scope.workspaceId) {
        throw new ScopeViolation(`workspace ${workspaceId} is outside the scope`);
      }
    };
    const connectionOf = (workspaceId: string, id: string): SocialConnection | null => {
      assertScope(workspaceId);
      const connection = state().connections.get(id);
      return connection?.workspaceId === workspaceId ? connection : null;
    };
    const accountOf = (workspaceId: string, id: string): SocialAccount | null => {
      assertScope(workspaceId);
      const account = state().accounts.get(id);
      return account?.workspaceId === workspaceId ? account : null;
    };

    return {
      connections: {
        find: (workspaceId, id) => Promise.resolve(connectionOf(workspaceId, id)),
        findByExternalUser(workspaceId, platform, method, externalUserId) {
          assertScope(workspaceId);
          const found = [...state().connections.values()].find(
            (connection) =>
              connection.workspaceId === workspaceId &&
              connection.platform === platform &&
              connection.method === method &&
              connection.externalUserId === externalUserId,
          );
          return Promise.resolve(found ?? null);
        },
        insert: (connection) => {
          assertScope(connection.workspaceId);
          state().connections.set(connection.id, {
            id: connection.id,
            workspaceId: connection.workspaceId,
            platform: connection.platform,
            method: connection.method,
            status: 'ACTIVE',
            externalUserId: connection.externalUserId,
            displayName: connection.displayName,
            accessTokenSealed: connection.accessTokenSealed,
            refreshTokenSealed: connection.refreshTokenSealed,
            sessionSealed: connection.sessionSealed,
            accessTokenExpiresAt: connection.accessTokenExpiresAt,
            refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
            scopes: connection.scopes,
            version: 0,
          });
          return Promise.resolve();
        },
        replaceGrant: (workspaceId, id, grant) => {
          const connection = connectionOf(workspaceId, id);
          if (connection) {
            state().connections.set(id, {
              ...connection,
              status: 'ACTIVE',
              displayName: grant.displayName,
              accessTokenSealed: grant.accessTokenSealed,
              refreshTokenSealed: grant.refreshTokenSealed,
              sessionSealed: grant.sessionSealed,
              accessTokenExpiresAt: grant.accessTokenExpiresAt,
              refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
              scopes: grant.scopes,
              version: connection.version + 1,
            });
          }
          return Promise.resolve();
        },
        revoke: (workspaceId, id) => {
          const connection = connectionOf(workspaceId, id);
          if (connection) {
            state().connections.set(id, {
              ...connection,
              status: 'REVOKED',
              accessTokenSealed: null,
              refreshTokenSealed: null,
              sessionSealed: null,
              version: connection.version + 1,
            });
          }
          return Promise.resolve();
        },
      },
      accounts: {
        find: (workspaceId, id) => Promise.resolve(accountOf(workspaceId, id)),
        findByExternalIds(workspaceId, platform, externalIds) {
          assertScope(workspaceId);
          return Promise.resolve(
            [...state().accounts.values()].filter(
              (account) =>
                account.workspaceId === workspaceId &&
                account.platform === platform &&
                externalIds.includes(account.externalId),
            ),
          );
        },
        upsert: (write) => {
          assertScope(write.workspaceId);
          const existing = [...state().accounts.values()].find(
            (account) =>
              account.workspaceId === write.workspaceId &&
              account.platform === write.platform &&
              account.externalId === write.externalId,
          );
          if (existing && existing.id !== write.id) {
            throw new Error('upsert with a new id for an existing account');
          }
          state().accounts.set(write.id, {
            id: write.id,
            workspaceId: write.workspaceId,
            connectionId: write.connectionId,
            platform: write.platform,
            type: write.type,
            externalId: write.externalId,
            name: write.name,
            handle: write.handle,
            avatarUrl: write.avatarUrl,
            accessTokenSealed: write.accessTokenSealed,
            disconnectedAt: null,
            version: existing ? existing.version + 1 : 0,
          });
          if (write.settings) {
            state().accountSettings.set(write.id, { ...write.settings });
          }
          return Promise.resolve();
        },
        disconnect: (workspaceId, id, at) => {
          const account = accountOf(workspaceId, id);
          if (!account || account.disconnectedAt !== null) {
            return Promise.resolve(false);
          }
          state().accounts.set(id, { ...account, disconnectedAt: at, accessTokenSealed: null });
          return Promise.resolve(true);
        },
        connectedCount(workspaceId, connectionId) {
          assertScope(workspaceId);
          return Promise.resolve(
            [...state().accounts.values()].filter(
              (account) =>
                account.workspaceId === workspaceId &&
                account.connectionId === connectionId &&
                account.disconnectedAt === null,
            ).length,
          );
        },
      },
      audit: {
        record: (entry) => {
          state().audit.push(entry);
          return Promise.resolve();
        },
      },
    };
  }
}

export class MemoryStates implements OAuthStateStore {
  readonly states = new Map<string, OAuthState>();

  save(state: string, data: OAuthState): Promise<void> {
    this.states.set(state, data);
    return Promise.resolve();
  }

  take(state: string): Promise<OAuthState | null> {
    const data = this.states.get(state) ?? null;
    this.states.delete(state);
    return Promise.resolve(data);
  }
}

export class MemoryPendings implements PendingConnectionStore {
  readonly pendings = new Map<string, PendingConnection>();

  save(pending: PendingConnection): Promise<void> {
    this.pendings.set(pending.id, pending);
    return Promise.resolve();
  }

  find(id: string): Promise<PendingConnection | null> {
    return Promise.resolve(this.pendings.get(id) ?? null);
  }

  delete(id: string): Promise<void> {
    this.pendings.delete(id);
    return Promise.resolve();
  }
}

/** Seals as "aad|plaintext"; opening with another AAD fails like AES-GCM would. */
export const fakeSealer: SecretSealer = {
  seal: (plaintext, aad) => Promise.resolve(new TextEncoder().encode(`${aad}|${plaintext}`)),
  open(sealed, aad) {
    const text = new TextDecoder().decode(sealed);
    return text.startsWith(`${aad}|`)
      ? Promise.resolve(text.slice(aad.length + 1))
      : Promise.reject(new Error('INVALID'));
  },
};

export const sequentialRandom = (): OAuthRandom => {
  let next = 0;
  return {
    token: () => `token-${String((next += 1))}`,
    pkce: () => ({ verifier: `verifier-${String((next += 1))}`, challenge: `challenge-${String(next)}` }),
  };
};

/** A connector that grants for the code "good" and lists the accounts it was given. */
export class FakeConnector implements OAuthConnector {
  readonly revoked: TokenSet[] = [];
  readonly exchanges: { code: string; redirectUri: string; codeVerifier: string | null }[] = [];
  grantedScopes: string[];
  accounts: ConnectableAccount[] = [
    {
      externalId: 'page-1',
      type: 'PAGE',
      name: 'Page One',
      handle: null,
      avatarUrl: null,
      accessToken: 'page-token-1',
    },
    {
      externalId: 'page-2',
      type: 'PAGE',
      name: 'Page Two',
      handle: null,
      avatarUrl: null,
      accessToken: null,
    },
  ];
  externalUserId = 'user-1';

  constructor(
    readonly scopes: readonly string[] = ['read', 'write', 'insights'],
    readonly usesPkce = false,
  ) {
    this.grantedScopes = [...scopes];
  }

  authorizationUrl(request: { state: string; redirectUri: string; codeChallenge: string | null }): string {
    const url = new URL('https://platform.example/authorize');
    url.searchParams.set('state', request.state);
    url.searchParams.set('redirect_uri', request.redirectUri);
    if (request.codeChallenge) {
      url.searchParams.set('code_challenge', request.codeChallenge);
    }
    return url.toString();
  }

  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthGrant> {
    this.exchanges.push(input);
    if (input.code !== 'good') {
      return Promise.reject(new PlatformError('VALIDATION_REJECTED', 'invalid_grant', { status: 400 }));
    }
    return Promise.resolve({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: new Date('2026-12-15T12:00:00Z'),
      refreshTokenExpiresAt: null,
      scopes: this.grantedScopes,
      externalUserId: this.externalUserId,
      displayName: 'Mira',
    });
  }

  listConnectableAccounts(): Promise<ConnectableAccount[]> {
    return Promise.resolve(this.accounts);
  }

  revoke(tokens: TokenSet): Promise<void> {
    this.revoked.push(tokens);
    return Promise.resolve();
  }
}

export const fakeConnectors = (
  connectors: Partial<Record<string, { method: ConnectionMethod; connector: OAuthConnector }>>,
): ChannelConnectors => ({
  methodFor: (platform) => connectors[platform]?.method ?? null,
  connector: (platform, method) => {
    const entry = connectors[platform];
    return entry?.method === method ? entry.connector : null;
  },
});

/** The account limit of the plan over the connected accounts of the in-memory store. */
export class MemoryAccountLimits implements AccountLimits {
  max = Number.POSITIVE_INFINITY;
  readonly asked: number[] = [];

  constructor(private readonly channels: InMemoryChannels) {}

  assertRoom(_organizationId: string, adding: number): Promise<void> {
    this.asked.push(adding);
    const used = [...this.channels.state.accounts.values()].filter((a) => a.disconnectedAt === null).length;
    if (adding > 0 && used + adding > this.max) {
      return Promise.reject(new PlanLimitReachedError('maxSocialAccounts', this.max));
    }
    return Promise.resolve();
  }
}

export interface ChannelTestbed extends ChannelDependencies {
  unitOfWork: InMemoryChannels;
  states: MemoryStates;
  pendings: MemoryPendings;
  accounts: MemoryAccountLimits;
  facebook: FakeConnector;
  x: FakeConnector;
}

export function createChannelTestbed(): ChannelTestbed {
  const facebook = new FakeConnector();
  const x = new FakeConnector(['tweet.read', 'offline.access'], true);
  const unitOfWork = new InMemoryChannels();
  return {
    unitOfWork,
    connectors: fakeConnectors({
      FACEBOOK: { method: 'API', connector: facebook },
      X: { method: 'API', connector: x },
    }),
    states: new MemoryStates(),
    pendings: new MemoryPendings(),
    sealer: fakeSealer,
    random: sequentialRandom(),
    clock: fixedClock(),
    ids: sequentialIds('ch'),
    callbackUrl: (platform) => `http://localhost:3000/api/oauth/${platform.toLowerCase()}/callback`,
    accounts: new MemoryAccountLimits(unitOfWork),
    facebook,
    x,
  };
}
