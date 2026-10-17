import type { Clock } from '../../shared/ports/clock';
import { isPlatformError } from '../domain/platform-error';
import { accountSecretAad, connectionSecretAad } from '../domain/secrets';
import { TOKEN_REFRESH_MARGIN_MS } from '../domain/token-monitor';
import type { SocialConnection } from '../domain/types';
import type {
  AdapterContext,
  CredentialsAccessor,
  RefreshOutcome,
  SocialPlatformAdapter,
  TokenSet,
} from '../ports/platform-adapter';
import type { SecretSealer } from '../ports/secrets';
import type { ConnectedAccount, ConnectionLock, TokenConnectionRepository } from '../ports/token-maintenance';

// The tokens of a connection while a job uses them (guide steps 4.8 and 4.9, architecture 7,
// step 5): opened only when the adapter asks for them, renewed when they run out soon or the
// platform refused them. A refresh runs under the lock of its connection and reads the
// connection again after the lock, because the refresh tokens of X are good for one use only.

/** The connection needs a new grant from the user. */
export class ReauthRequiredError extends Error {
  constructor(readonly reason: string) {
    super(`The connection needs a new grant: ${reason}.`);
    this.name = 'ReauthRequiredError';
  }
}

/** The account a job acts for, with the connection that reaches it. */
export interface TokenTarget extends ConnectedAccount {
  connection: SocialConnection;
}

/**
 * What a refresh did. not_due: the token lasts and nothing forced a refresh; renewed_elsewhere:
 * another job renewed it while this one waited for the lock.
 */
export type TokenRefreshResult =
  'refreshed' | 'not_needed' | 'not_supported' | 'renewed_elsewhere' | 'not_due';

export class ConnectionTokens {
  private connection: SocialConnection;
  /** A refused token gets one refresh per job. */
  private refreshedAfterRefusal = false;

  constructor(
    private readonly deps: { sealer: SecretSealer; locks: ConnectionLock; clock: Clock },
    /** A unit of work of the job on the connections. */
    private readonly unit: <T>(work: (connections: TokenConnectionRepository) => Promise<T>) => Promise<T>,
    private readonly target: ConnectedAccount,
    connection: SocialConnection,
    private readonly adapter: SocialPlatformAdapter,
  ) {
    this.connection = connection;
  }

  get connectionId(): string {
    return this.connection.id;
  }

  /** The connection as the job knows it now, after a refresh with its new tokens. */
  get current(): SocialConnection {
    return this.connection;
  }

  /** The tokens of the connection as it is now: the token of the account, or of the connection. */
  credentials(): CredentialsAccessor {
    const { sealer } = this.deps;
    const { target } = this;
    const connection = this.connection;
    const { workspaceId, id } = connection;
    return {
      accessToken: () => {
        if (target.accessTokenSealed) {
          return sealer.open(target.accessTokenSealed, accountSecretAad(workspaceId, id, target.account.id));
        }
        if (!connection.accessTokenSealed) {
          return Promise.reject(new ReauthRequiredError('TOKEN_MISSING'));
        }
        return sealer.open(
          connection.accessTokenSealed,
          connectionSecretAad(workspaceId, id, 'access_token'),
        );
      },
      refreshToken: () =>
        connection.refreshTokenSealed
          ? sealer.open(connection.refreshTokenSealed, connectionSecretAad(workspaceId, id, 'refresh_token'))
          : Promise.resolve(null),
    };
  }

  /**
   * Runs a call of the platform; a refused token gets one refresh and the call one more try. A
   * platform that cannot renew a refused token needs a new grant.
   */
  async withToken<T>(context: () => AdapterContext, call: (ctx: AdapterContext) => Promise<T>): Promise<T> {
    try {
      return await call(context());
    } catch (error) {
      if (!isPlatformError(error) || error.code !== 'AUTH_EXPIRED' || this.refreshedAfterRefusal) {
        throw error;
      }
      if (this.adapter.method === 'BROWSER') {
        // Only the user renews a session of the browser, by signing in again.
        throw new ReauthRequiredError('SESSION_EXPIRED');
      }
      this.refreshedAfterRefusal = true;
      if ((await this.refresh(context, true)) === 'not_supported') {
        throw new ReauthRequiredError('REFRESH_NOT_SUPPORTED');
      }
      return await call(context());
    }
  }

  /** Renews the token when it runs out soon, or always (force). */
  async refresh(context: () => AdapterContext, force: boolean): Promise<TokenRefreshResult> {
    const used = this.connection;
    if (this.adapter.method === 'BROWSER' || (!force && !this.expiresSoon(used))) {
      return 'not_due';
    }
    return this.deps.locks.withConnectionLock(used.id, async () => {
      const current = await this.unit((connections) => connections.find(used.workspaceId, used.id));
      if (!current?.accessTokenSealed || !(current.status === 'ACTIVE' || current.status === 'EXPIRING')) {
        throw new ReauthRequiredError('TOKEN_MISSING');
      }
      this.connection = current;
      if (current.version !== used.version && !this.expiresSoon(current)) {
        return 'renewed_elsewhere';
      }
      let outcome: RefreshOutcome;
      try {
        outcome = await this.adapter.refreshCredentials(context());
      } catch (error) {
        if (isPlatformError(error) && error.code === 'AUTH_EXPIRED') {
          throw new ReauthRequiredError('REFRESH_FAILED');
        }
        throw error;
      }
      if (outcome.status === 'refreshed') {
        await this.store(current, outcome.tokens);
      }
      return outcome.status;
    });
  }

  private expiresSoon(connection: SocialConnection): boolean {
    return (
      connection.accessTokenExpiresAt !== null &&
      connection.accessTokenExpiresAt.getTime() - this.deps.clock.now().getTime() < TOKEN_REFRESH_MARGIN_MS
    );
  }

  /** Seals the new tokens; without a new refresh token the old one stays (RFC 6749, 6). */
  private async store(current: SocialConnection, tokens: TokenSet): Promise<void> {
    const { sealer } = this.deps;
    const aad = (field: 'access_token' | 'refresh_token'): string =>
      connectionSecretAad(current.workspaceId, current.id, field);
    const sealed = {
      accessTokenSealed: await sealer.seal(tokens.accessToken, aad('access_token')),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenSealed:
        tokens.refreshToken === null
          ? current.refreshTokenSealed
          : await sealer.seal(tokens.refreshToken, aad('refresh_token')),
      refreshTokenExpiresAt:
        tokens.refreshToken === null ? current.refreshTokenExpiresAt : tokens.refreshTokenExpiresAt,
      scopes: tokens.scopes.length > 0 ? [...tokens.scopes] : current.scopes,
    };
    const stored = await this.unit((connections) =>
      connections.storeRefresh(current.workspaceId, current.id, current.version, {
        ...sealed,
        refreshedAt: this.deps.clock.now(),
      }),
    );
    if (!stored) {
      throw new Error('The connection changed during its refresh.');
    }
    this.connection = { ...current, ...sealed, version: current.version + 1 };
  }
}
