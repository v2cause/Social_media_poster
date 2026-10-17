import { browserContextOf } from '../../channels/application/browser-context';
import { ConnectionTokens, ReauthRequiredError } from '../../channels/application/connection-tokens';
import { isPlatformError } from '../../channels/domain/platform-error';
import type {
  AdapterContext,
  AdapterLogger,
  SocialPlatformAdapter,
} from '../../channels/ports/platform-adapter';
import type { SecretSealer } from '../../channels/ports/secrets';
import type { AdapterResolver, ConnectionLock } from '../../channels/ports/token-maintenance';
import { isConnectionUsable } from '../../publishing/domain/rules';
import type { ApiCostEntry, OperationPrices, PublishJobTarget } from '../../publishing/ports/publish-job';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import { localDayOf } from '../domain/days';
import type { AnalyticsScope, AnalyticsStore, AnalyticsUnitOfWork, RollupRequests } from '../ports/analytics';

// What the analytics jobs share (guide step 5.2): the account with its adapter and tokens, the
// context of a call with its costs, and how long the polls of an account wait after a failure.
// Polls are best effort: a failure postpones them instead of failing the job.

export interface AnalyticsJobDependencies {
  unitOfWork: AnalyticsUnitOfWork;
  adapters: AdapterResolver;
  /** Opens and seals tokens with the token keyring. */
  sealer: SecretSealer;
  locks: ConnectionLock;
  prices: OperationPrices;
  clock: Clock;
  ids: IdGenerator;
  logger: AdapterLogger;
  /** The rollup of the days a run touched (guide step 5.3). */
  rollups: RollupRequests;
  /** ANALYTICS_CADENCE_SCALE: above 1 the cascade runs faster, for tests. */
  cadenceScale?: number;
}

export interface AnalyticsJobInput extends AnalyticsScope {
  accountId: string;
  /** Aborted when the worker stops at once; the job then writes nothing more. */
  signal: AbortSignal;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long polls wait: after a rate limit without Retry-After, a refused access, anything else. */
export const POLL_RETRY_MS = {
  rateLimited: 15 * MINUTE_MS,
  access: 6 * HOUR_MS,
  other: 30 * MINUTE_MS,
} as const;

/** How long the polls of an account wait after this error; null for errors that are no answer of the platform. */
export function pollWaitAfter(error: unknown): number | null {
  if (error instanceof ReauthRequiredError) {
    return POLL_RETRY_MS.access;
  }
  if (!isPlatformError(error)) {
    return null;
  }
  switch (error.code) {
    case 'RATE_LIMITED':
    case 'SPEND_CAP_REACHED':
      return error.retryAfterMs ?? POLL_RETRY_MS.rateLimited;
    case 'AUTH_EXPIRED':
    case 'PERMISSION_DENIED':
    case 'CHALLENGE_REQUIRED':
      return POLL_RETRY_MS.access;
    default:
      return POLL_RETRY_MS.other;
  }
}

/**
 * A challenge of the browser of X, or its lost session, stops every poll of the connection until
 * the user signs in again (architecture 4.3): NEEDS_REAUTH and a notification, never another try
 * on its own. Returns true when the error was one of them.
 */
export async function stopUntilSignIn(
  deps: AnalyticsJobDependencies,
  input: AnalyticsJobInput,
  connectionId: string,
  error: unknown,
): Promise<boolean> {
  const reason =
    isPlatformError(error) && error.code === 'CHALLENGE_REQUIRED'
      ? 'CHALLENGE_REQUIRED'
      : error instanceof ReauthRequiredError && error.reason === 'SESSION_EXPIRED'
        ? 'SESSION_EXPIRED'
        : null;
  if (reason === null) {
    return false;
  }
  await unitOf(deps, input, async (store) => {
    const mark = await store.connections.markNeedsReauth(input.workspaceId, connectionId, reason);
    if (mark.changed) {
      await store.outbox.add(input.workspaceId, {
        type: 'notification.requested',
        payload: { type: 'reauth-required', connectionId, reason, scheduledVariants: mark.scheduledVariants },
      });
    }
  });
  deps.logger.warn({ accountId: input.accountId, connectionId, reason }, 'analytics.sign_in_required');
  return true;
}

/** The account of a job, ready to call its platform, or why it cannot be polled now. */
export type AccountAccess =
  | { kind: 'ready'; target: PublishJobTarget; adapter: SocialPlatformAdapter; tokens: ConnectionTokens }
  | { kind: 'missing' }
  | { kind: 'disconnected' }
  | { kind: 'unusable' }
  | { kind: 'no_adapter' };

export const unitOf = <T>(
  deps: AnalyticsJobDependencies,
  scope: AnalyticsScope,
  work: (store: AnalyticsStore) => Promise<T>,
): Promise<T> =>
  deps.unitOfWork.run({ organizationId: scope.organizationId, workspaceId: scope.workspaceId }, work);

export async function accessAccount(
  deps: AnalyticsJobDependencies,
  input: AnalyticsJobInput,
): Promise<AccountAccess> {
  const target = await unitOf(deps, input, (store) => store.targets.find(input.workspaceId, input.accountId));
  if (!target) {
    return { kind: 'missing' };
  }
  if (target.disconnectedAt !== null) {
    return { kind: 'disconnected' };
  }
  if (!isConnectionUsable(target.connection.status)) {
    return { kind: 'unusable' };
  }
  const adapter = await deps.adapters.resolve({
    platform: target.account.platform,
    method: target.connection.method,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
  });
  if (!adapter) {
    return { kind: 'no_adapter' };
  }
  const tokens = new ConnectionTokens(
    deps,
    (work) => unitOf(deps, input, (store) => work(store.connections)),
    { account: target.account, accessTokenSealed: target.accessTokenSealed },
    target.connection,
    adapter,
  );
  return { kind: 'ready', target, adapter, tokens };
}

/** Collects the paid calls of a run (X), booked with its result. */
export class CallCosts {
  private readonly units = new Map<string, number>();

  record(operation: string, units = 1): void {
    this.units.set(operation, (this.units.get(operation) ?? 0) + units);
  }

  /** The entries of the ledger, once per source and operation. */
  entries(
    deps: Pick<AnalyticsJobDependencies, 'prices' | 'logger'>,
    input: AnalyticsJobInput,
    target: PublishJobTarget,
    sourceId: string,
  ): ApiCostEntry[] {
    return [...this.units].map(([operation, units]) => {
      const price = deps.prices.priceMicros(operation);
      if (price === null) {
        deps.logger.warn({ operation, accountId: input.accountId }, 'analytics.price_unknown');
      }
      return {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        socialAccountId: input.accountId,
        platform: target.account.platform,
        operation,
        units,
        costMicros: (price ?? 0) * units,
        sourceType: 'metrics_poll',
        sourceId,
      };
    });
  }
}

/** The context of the calls of a run: no dry run, no lease to keep alive. */
export function contextOf(
  deps: AnalyticsJobDependencies,
  input: AnalyticsJobInput,
  access: Extract<AccountAccess, { kind: 'ready' }>,
  costs: CallCosts,
): AdapterContext {
  return {
    account: access.target.account,
    credentials: access.tokens.credentials(),
    ...browserContextOf(access.target, input.organizationId),
    costs: {
      record: ({ operation, units }) => {
        costs.record(operation, units);
        return Promise.resolve();
      },
    },
    logger: deps.logger,
    signal: input.signal,
    dryRun: false,
    keepAlive: () => Promise.resolve(),
  };
}

/**
 * Asks for the rollup of the local days of these instants. A request that fails is logged: the
 * nightly rollup fills the days anyway.
 */
export async function requestRollup(
  deps: AnalyticsJobDependencies,
  input: AnalyticsJobInput,
  instants: readonly Date[],
): Promise<void> {
  if (instants.length === 0) {
    return;
  }
  try {
    const timeZone =
      (await unitOf(deps, input, (store) => store.workspaces.timeZoneOf(input.workspaceId))) ?? 'UTC';
    const days = instants.map((instant) => localDayOf(instant, timeZone)).sort();
    await deps.rollups.request({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      from: days[0] ?? '',
      to: days.at(-1) ?? '',
    });
  } catch (error) {
    deps.logger.warn({ accountId: input.accountId, err: error }, 'analytics.rollup_request_failed');
  }
}
