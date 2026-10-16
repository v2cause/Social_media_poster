import { capabilitiesOf, type Platform, type ValidationIssue } from '@smp/platform-rules';

import type {
  AdapterAccount,
  AdapterContext,
  ApiCostEntry,
  ConnectionMethod,
  NewPublishAttempt,
  OAuthConnector,
  OutboxEventInput,
  PublishAttemptOutcome,
  PublishJobDependencies,
  PublishJobScope,
  PublishJobStore,
  PublishJobTarget,
  PublishJobUnitOfWork,
  PublishJobVariant,
  PublishMediaItem,
  PublishRendition,
  PublishRequest,
  PublishResult,
  RefreshOutcome,
  SocialConnection,
  SocialPlatformAdapter,
} from '../src';
import { connectionSecretAad } from '../src';
import { fakeSealer } from './in-memory-channels';
import { ScopeViolation, sequentialIds } from './in-memory-content';

// In-memory adapters for the publish job: a unit of work that hides other workspaces and rolls
// back on errors, a clock that moves, a lock per connection, and an adapter that answers from a
// script.

export interface VariantRow extends PublishJobVariant {
  publishedAt: Date | null;
  externalPostId: string | null;
  externalUrl: string | null;
  failureCode: string | null;
  lastError: string | null;
  isDryRun: boolean;
  contentHash: string | null;
  metricsNextAt: Date | null;
}

export interface AttemptRow extends NewPublishAttempt {
  attemptNumber: number;
  outcome: PublishAttemptOutcome;
  errorCode: string | null;
  errorMessage: string | null;
  externalPostId: string | null;
  meta: Readonly<Record<string, unknown>>;
  finishedAt: Date | null;
}

export interface ConnectionRow extends SocialConnection {
  statusReason: string | null;
  lastRefreshedAt: Date | null;
}

interface AccountRow {
  account: AdapterAccount;
  disconnectedAt: Date | null;
  accessTokenSealed: Uint8Array | null;
}

interface State {
  variants: Map<string, VariantRow>;
  attempts: AttemptRow[];
  accounts: Map<string, AccountRow>;
  connections: Map<string, ConnectionRow>;
  media: Map<string, PublishMediaItem[]>;
  renditions: Map<string, PublishRendition>;
  costs: ApiCostEntry[];
  outbox: (OutboxEventInput & { workspaceId: string })[];
}

const renditionKey = (assetId: string, profile: string, cropHash: string): string =>
  `${assetId}|${profile}|${cropHash}`;

export class InMemoryPublishJobs implements PublishJobUnitOfWork {
  state: State = {
    variants: new Map(),
    attempts: [],
    accounts: new Map(),
    connections: new Map(),
    media: new Map(),
    renditions: new Map(),
    costs: [],
    outbox: [],
  };
  /** Runs before every unit of work, for example to fail it. */
  beforeRun: (() => void) | null = null;

  async run<T>(scope: PublishJobScope, work: (store: PublishJobStore) => Promise<T>): Promise<T> {
    this.beforeRun?.();
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.storeFor(scope));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  variant(id = 'variant-1'): VariantRow {
    const variant = this.state.variants.get(id);
    if (!variant) {
      throw new Error(`no variant ${id}`);
    }
    return variant;
  }

  connection(id = 'connection-1'): ConnectionRow {
    const connection = this.state.connections.get(id);
    if (!connection) {
      throw new Error(`no connection ${id}`);
    }
    return connection;
  }

  attempts(variantId = 'variant-1'): AttemptRow[] {
    return this.state.attempts.filter((attempt) => attempt.variantId === variantId);
  }

  /** The payloads of the notification requests in the outbox. */
  notifications(): unknown[] {
    return this.state.outbox.flatMap((event) =>
      event.type === 'notification.requested' ? [event.payload] : [],
    );
  }

  statuses(): string[] {
    return this.state.outbox.flatMap((event) => ('status' in event.payload ? [event.payload.status] : []));
  }

  setRendition(assetId: string, profile: string, cropHash: string, rendition: PublishRendition): void {
    this.state.renditions.set(renditionKey(assetId, profile, cropHash), rendition);
  }

  private storeFor(scope: PublishJobScope): PublishJobStore {
    // The state is replaced on a rollback, so the repositories read it through this getter.
    const state = (): State => this.state;
    const assertScope = (workspaceId: string): void => {
      if (workspaceId !== scope.workspaceId) {
        throw new ScopeViolation(`workspace ${workspaceId} is outside the scope`);
      }
    };
    const variantOf = (workspaceId: string, id: string): VariantRow | null => {
      assertScope(workspaceId);
      const variant = state().variants.get(id);
      return variant?.workspaceId === workspaceId ? variant : null;
    };
    const update = (variant: VariantRow, change: Partial<VariantRow>): number => {
      const version = variant.version + 1;
      state().variants.set(variant.id, { ...variant, ...change, version });
      return version;
    };
    const attemptOf = (workspaceId: string, id: string): AttemptRow => {
      assertScope(workspaceId);
      const attempt = state().attempts.find((candidate) => candidate.id === id);
      if (!attempt) {
        throw new Error(`no attempt ${id}`);
      }
      return attempt;
    };

    return {
      variants: {
        // Copies, like rows read from a database.
        lockForJob: (workspaceId, id) => Promise.resolve(structuredClone(variantOf(workspaceId, id))),
        claim(workspaceId, id, version, lease) {
          const variant = variantOf(workspaceId, id);
          if (variant?.version !== version) {
            return Promise.resolve(null);
          }
          return Promise.resolve(
            update(variant, { status: 'PUBLISHING', leaseOwner: lease.owner, leaseUntil: lease.until }),
          );
        },
        extendLease(workspaceId, id, version, lease) {
          const variant = variantOf(workspaceId, id);
          if (
            variant?.version !== version ||
            variant.leaseOwner !== lease.owner ||
            variant.status !== 'PUBLISHING'
          ) {
            return Promise.resolve(null);
          }
          return Promise.resolve(update(variant, { leaseUntil: lease.until }));
        },
        finish(workspaceId, id, version, owner, result) {
          const variant = variantOf(workspaceId, id);
          if (
            variant?.version !== version ||
            variant.leaseOwner !== owner ||
            variant.status !== 'PUBLISHING'
          ) {
            return Promise.resolve(false);
          }
          const fields =
            result.status === 'PUBLISHED'
              ? { ...result, failureCode: null, lastError: null }
              : { status: result.status, failureCode: result.failureCode, lastError: result.lastError };
          update(variant, { ...fields, leaseOwner: null, leaseUntil: null });
          return Promise.resolve(true);
        },
        fail(workspaceId, id, version, failureCode) {
          const variant = variantOf(workspaceId, id);
          if (variant?.version !== version) {
            return Promise.resolve(false);
          }
          update(variant, { status: 'FAILED', failureCode, lastError: null });
          return Promise.resolve(true);
        },
      },
      attempts: {
        unclear(workspaceId, variantId) {
          assertScope(workspaceId);
          return Promise.resolve(
            state()
              .attempts.filter(
                (attempt) =>
                  attempt.variantId === variantId &&
                  (attempt.outcome === 'STARTED' || attempt.outcome === 'UNKNOWN'),
              )
              .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
              .map((attempt) => ({
                scheduleVersion: attempt.scheduleVersion,
                outcome: attempt.outcome as 'STARTED' | 'UNKNOWN',
                startedAt: attempt.startedAt,
              })),
          );
        },
        start(attempt) {
          assertScope(attempt.workspaceId);
          const numbers = state()
            .attempts.filter(
              (row) => row.variantId === attempt.variantId && row.scheduleVersion === attempt.scheduleVersion,
            )
            .map((row) => row.attemptNumber);
          const attemptNumber = Math.max(0, ...numbers) + 1;
          state().attempts.push({
            ...attempt,
            attemptNumber,
            outcome: 'STARTED',
            errorCode: null,
            errorMessage: null,
            externalPostId: null,
            meta: {},
            finishedAt: null,
          });
          return Promise.resolve(attemptNumber);
        },
        markSent(workspaceId, attemptId) {
          attemptOf(workspaceId, attemptId).outcome = 'UNKNOWN';
          return Promise.resolve();
        },
        finish(workspaceId, attemptId, result) {
          Object.assign(attemptOf(workspaceId, attemptId), result);
          return Promise.resolve();
        },
      },
      targets: {
        find(workspaceId, accountId) {
          assertScope(workspaceId);
          const row = state().accounts.get(accountId);
          const connection = row ? state().connections.get(row.account.connectionId) : undefined;
          if (row?.account.workspaceId !== workspaceId || !connection) {
            return Promise.resolve(null);
          }
          const target: PublishJobTarget = structuredClone({ ...row, connection });
          return Promise.resolve(target);
        },
      },
      connections: {
        find(workspaceId, id) {
          assertScope(workspaceId);
          const connection = state().connections.get(id);
          return Promise.resolve(
            connection?.workspaceId === workspaceId ? structuredClone(connection) : null,
          );
        },
        storeRefresh(workspaceId, id, version, tokens) {
          assertScope(workspaceId);
          const connection = state().connections.get(id);
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
        markNeedsReauth(workspaceId, id, reason) {
          assertScope(workspaceId);
          const connection = state().connections.get(id);
          if (connection?.status !== 'ACTIVE' && connection?.status !== 'EXPIRING') {
            return Promise.resolve({ changed: false, scheduledVariants: 0 });
          }
          state().connections.set(id, {
            ...connection,
            status: 'NEEDS_REAUTH',
            statusReason: reason,
            version: connection.version + 1,
          });
          const accounts = [...state().accounts.values()]
            .filter((row) => row.account.connectionId === id)
            .map((row) => row.account.id);
          let scheduledVariants = 0;
          for (const variant of state().variants.values()) {
            if (variant.status === 'SCHEDULED' && accounts.includes(variant.socialAccountId ?? '')) {
              variant.failureCode = 'REAUTH_REQUIRED';
              scheduledVariants += 1;
            }
          }
          return Promise.resolve({ changed: true, scheduledVariants });
        },
      },
      media: {
        itemsOf(workspaceId, variantId) {
          assertScope(workspaceId);
          return Promise.resolve(state().media.get(variantId) ?? []);
        },
        rendition(workspaceId, assetId, profile, cropHash) {
          assertScope(workspaceId);
          return Promise.resolve(state().renditions.get(renditionKey(assetId, profile, cropHash)) ?? null);
        },
      },
      costs: {
        record(entries) {
          for (const entry of entries) {
            assertScope(entry.workspaceId);
            const exists = state().costs.some(
              (row) => row.sourceId === entry.sourceId && row.operation === entry.operation,
            );
            if (!exists) {
              state().costs.push(entry);
            }
          }
          return Promise.resolve();
        },
      },
      outbox: {
        add(workspaceId, event) {
          assertScope(workspaceId);
          state().outbox.push({ ...event, workspaceId });
          return Promise.resolve();
        },
      },
    };
  }
}

/** A clock that tests move forward. */
export class MovingClock {
  constructor(private at: number) {}
  now(): Date {
    return new Date(this.at);
  }
  advance(ms: number): void {
    this.at += ms;
  }
}

type Answer<T> = T | Error;

/** Takes the next answer of a script; the last one repeats. */
function next<T>(answers: Answer<T>[], fallback: () => T): T {
  const answer = answers.length > 1 ? answers.shift() : answers[0];
  if (answer === undefined) {
    return fallback();
  }
  if (answer instanceof Error) {
    throw answer;
  }
  return answer;
}

const UNUSED_CONNECTOR: OAuthConnector = {
  scopes: [],
  usesPkce: false,
  authorizationUrl: () => 'https://platform.example/authorize',
  exchangeCode: () => Promise.reject(new Error('not used')),
  listConnectableAccounts: () => Promise.resolve([]),
  revoke: () => Promise.resolve(),
};

/** An adapter that answers from scripts and keeps what it was asked. */
export class ScriptedAdapter implements SocialPlatformAdapter {
  readonly connector = UNUSED_CONNECTOR;
  readonly calls = { publish: 0, reconcile: 0, refresh: 0 };
  readonly requests: PublishRequest[] = [];
  readonly queries: { text: string; since: Date; contentHash: string }[] = [];
  /** The access token of every call. */
  readonly tokens: string[] = [];
  publishAnswers: Answer<PublishResult>[] = [];
  reconcileAnswers: Answer<PublishResult | null>[] = [];
  refreshAnswers: Answer<RefreshOutcome>[] = [];
  issues: ValidationIssue[] = [];
  /** Runs inside publish before the answer, for example to record costs or stop the worker. */
  duringPublish: ((ctx: AdapterContext) => Promise<void>) | null = null;
  duringReconcile: ((ctx: AdapterContext) => Promise<void>) | null = null;

  constructor(
    readonly platform: Platform = 'LINKEDIN',
    readonly method: ConnectionMethod = 'API',
    private readonly clock: { now(): Date } = { now: () => new Date('2026-10-16T12:00:00Z') },
  ) {}

  capabilities() {
    return capabilitiesOf(this.platform);
  }

  async refreshCredentials(ctx: AdapterContext): Promise<RefreshOutcome> {
    this.calls.refresh += 1;
    this.tokens.push(`refresh:${String(await ctx.credentials.refreshToken())}`);
    return next(this.refreshAnswers, () => ({
      status: 'refreshed',
      tokens: {
        accessToken: `access-${String(this.calls.refresh + 1)}`,
        refreshToken: `refresh-${String(this.calls.refresh + 1)}`,
        accessTokenExpiresAt: new Date(this.clock.now().getTime() + 2 * 60 * 60 * 1000),
        refreshTokenExpiresAt: null,
        scopes: [],
      },
    }));
  }

  validatePost(): ValidationIssue[] {
    return this.issues;
  }

  async publish(request: PublishRequest, ctx: AdapterContext): Promise<PublishResult> {
    this.calls.publish += 1;
    this.requests.push(request);
    this.tokens.push(await ctx.credentials.accessToken());
    await this.duringPublish?.(ctx);
    return next(this.publishAnswers, () => ({
      externalPostId: `post-${String(this.calls.publish)}`,
      externalUrl: `https://platform.example/posts/post-${String(this.calls.publish)}`,
      publishedAt: this.clock.now(),
    }));
  }

  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    this.calls.reconcile += 1;
    this.queries.push(query);
    this.tokens.push(await ctx.credentials.accessToken());
    await this.duringReconcile?.(ctx);
    return next(this.reconcileAnswers, () => null);
  }

  deletePost(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }

  fetchPostMetrics(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  fetchAccountMetrics(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
}

export interface PublishJobTestbed extends PublishJobDependencies {
  unitOfWork: InMemoryPublishJobs;
  clock: MovingClock;
  adapter: ScriptedAdapter;
  /** The connections whose lock was taken, in order. */
  locked: string[];
  warnings: string[];
}

export const NOW = Date.parse('2026-10-16T12:00:00Z');

/** Seals like the sealer of the testbed, for tokens of the seed. */
export const sealed = (plaintext: string, aad: string): Uint8Array =>
  new TextEncoder().encode(`${aad}|${plaintext}`);

/**
 * A queued LinkedIn variant of workspace ws-1 with an active API connection whose access token
 * runs for another hour; prices only for x.post_create.
 */
export function createPublishJobTestbed(
  options: { platform?: Platform; method?: ConnectionMethod; variant?: Partial<VariantRow> } = {},
): PublishJobTestbed {
  const platform = options.platform ?? 'LINKEDIN';
  const clock = new MovingClock(NOW);
  const unitOfWork = new InMemoryPublishJobs();
  const adapter = new ScriptedAdapter(platform, options.method ?? 'API', clock);
  const locked: string[] = [];
  const warnings: string[] = [];
  const bed: PublishJobTestbed = {
    unitOfWork,
    clock,
    adapter,
    locked,
    warnings,
    adapters: { resolve: () => Promise.resolve(adapter) },
    sealer: fakeSealer,
    locks: {
      withConnectionLock: (connectionId, work) => {
        locked.push(connectionId);
        return work();
      },
    },
    storage: { signedGetUrl: (key) => Promise.resolve(`https://storage.example/${key}?signature=s`) },
    prices: { priceMicros: (operation) => (operation === 'x.post_create' ? 15_000 : null) },
    hash: (value) => `hash(${value})`,
    ids: sequentialIds('attempt'),
    logger: {
      info: () => undefined,
      warn: (_fields, message) => {
        warnings.push(message);
      },
    },
    dryRunLive: false,
  };

  unitOfWork.state.variants.set('variant-1', {
    id: 'variant-1',
    workspaceId: 'ws-1',
    postId: 'post-1',
    platform,
    status: 'QUEUED',
    version: 7,
    scheduleVersion: 3,
    socialAccountId: 'account-1',
    text: 'Wir suchen Verstärkung im Kundendienst.',
    hashtags: ['Karriere'],
    firstComment: null,
    linkUrl: null,
    scheduledAt: new Date(NOW - 60_000),
    queuedAt: new Date(NOW - 30_000),
    leaseOwner: null,
    leaseUntil: null,
    dryRun: false,
    missedWindowBehavior: 'FAIL',
    publishedAt: null,
    externalPostId: null,
    externalUrl: null,
    failureCode: null,
    lastError: null,
    isDryRun: false,
    contentHash: null,
    metricsNextAt: null,
    ...options.variant,
  });
  unitOfWork.state.accounts.set('account-1', {
    account: {
      id: 'account-1',
      workspaceId: 'ws-1',
      connectionId: 'connection-1',
      platform,
      type: 'PROFILE',
      externalId: 'urn:li:person:1',
      name: 'Mira',
      handle: null,
      settings: {},
    },
    disconnectedAt: null,
    accessTokenSealed: null,
  });
  const aad = (field: 'access_token' | 'refresh_token') => connectionSecretAad('ws-1', 'connection-1', field);
  unitOfWork.state.connections.set('connection-1', {
    id: 'connection-1',
    workspaceId: 'ws-1',
    platform,
    method: options.method ?? 'API',
    status: 'ACTIVE',
    statusReason: null,
    externalUserId: 'user-1',
    displayName: 'Mira',
    accessTokenSealed: sealed('access-1', aad('access_token')),
    refreshTokenSealed: sealed('refresh-1', aad('refresh_token')),
    accessTokenExpiresAt: new Date(NOW + 60 * 60 * 1000),
    refreshTokenExpiresAt: new Date(NOW + 30 * 24 * 60 * 60 * 1000),
    scopes: ['w_member_social'],
    version: 2,
    lastRefreshedAt: null,
  });
  return bed;
}

/** The job of the seeded variant. */
export const jobOf = (
  overrides: Partial<{
    trigger: 'schedule' | 'now' | 'retry' | 'recheck' | 'sweep';
    lastAttempt: boolean;
    owner: string;
    signal: AbortSignal;
    scheduleVersion: number;
  }> = {},
) => ({
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  variantId: 'variant-1',
  scheduleVersion: 3,
  trigger: 'schedule' as const,
  lastAttempt: false,
  owner: 'worker-a:1',
  signal: new AbortController().signal,
  ...overrides,
});
