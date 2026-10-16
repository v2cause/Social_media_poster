import { isPlatformError } from '../../channels/domain/platform-error';
import { accountSecretAad, connectionSecretAad } from '../../channels/domain/secrets';
import type { SocialConnection } from '../../channels/domain/types';
import type {
  AdapterContext,
  CredentialsAccessor,
  RefreshOutcome,
  SocialPlatformAdapter,
  TokenSet,
} from '../../channels/ports/platform-adapter';
import { TOKEN_REFRESH_MARGIN_MS } from '../domain/publish-job';
import { isConnectionUsable } from '../domain/rules';
import type { PublishJobStore, PublishJobTarget } from '../ports/publish-job';
import type { PublishJobDependencies } from './publish-job-types';

// The tokens of one publish run (guide step 4.8, architecture 7, step 5): opened only when the
// adapter asks for them, renewed when they run out soon or the platform refused them. A refresh
// runs under the lock of its connection and reads the connection again after the lock, because
// the refresh tokens of X are good for one use only.

/** The connection needs a new grant from the user. */
export class ReauthRequiredError extends Error {
  constructor(readonly reason: string) {
    super(`The connection needs a new grant: ${reason}.`);
    this.name = 'ReauthRequiredError';
  }
}

export class ConnectionTokens {
  private connection: SocialConnection;
  /** A refused token gets one refresh per run. */
  private refreshedAfterRefusal = false;

  constructor(
    private readonly deps: Pick<PublishJobDependencies, 'sealer' | 'locks' | 'clock'>,
    /** A unit of work of the job. */
    private readonly unit: <T>(work: (store: PublishJobStore) => Promise<T>) => Promise<T>,
    private readonly target: PublishJobTarget,
    private readonly adapter: SocialPlatformAdapter,
  ) {
    this.connection = target.connection;
  }

  get connectionId(): string {
    return this.connection.id;
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

  /** Runs a call of the platform; a refused token gets one refresh and the call one more try. */
  async withToken<T>(context: () => AdapterContext, call: (ctx: AdapterContext) => Promise<T>): Promise<T> {
    try {
      return await call(context());
    } catch (error) {
      if (!isPlatformError(error) || error.code !== 'AUTH_EXPIRED' || this.refreshedAfterRefusal) {
        throw error;
      }
      this.refreshedAfterRefusal = true;
      await this.refresh(context, true);
      return await call(context());
    }
  }

  /** Renews the token when it runs out soon, or when the platform refused it (force). */
  async refresh(context: () => AdapterContext, force: boolean): Promise<void> {
    const used = this.connection;
    if (this.adapter.method === 'BROWSER' || (!force && !this.expiresSoon(used))) {
      return;
    }
    await this.deps.locks.withConnectionLock(used.id, async () => {
      const current = await this.unit((store) => store.connections.find(used.workspaceId, used.id));
      if (!current?.accessTokenSealed || !isConnectionUsable(current.status)) {
        throw new ReauthRequiredError('TOKEN_MISSING');
      }
      this.connection = current;
      if (current.version !== used.version && !this.expiresSoon(current)) {
        // Another run renewed it while this one waited for the lock.
        return;
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
      } else if (force && outcome.status === 'not_supported') {
        throw new ReauthRequiredError('REFRESH_NOT_SUPPORTED');
      }
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
    const stored = await this.unit((store) =>
      store.connections.storeRefresh(current.workspaceId, current.id, current.version, {
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
