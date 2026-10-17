import type { Platform } from '@smp/platform-rules';

import type {
  AccountDailyMetrics,
  AnalyticsJobDependencies,
  AnalyticsScope,
  AnalyticsStore,
  AnalyticsUnitOfWork,
  ApiCostEntry,
  ConnectionMethod,
  NormalizedPostMetrics,
  PublishJobTarget,
  SocialConnection,
} from '../src';
import { connectionSecretAad } from '../src';
import { fakeSealer } from './in-memory-channels';
import { ScopeViolation, sequentialIds } from './in-memory-content';
import { MovingClock, NOW, ScriptedAdapter, sealed } from './in-memory-publish-job';

export { metricsOf } from './in-memory-publish-job';

// In-memory adapters for the analytics jobs (guide step 5.2): a unit of work that hides other
// workspaces and rolls back on errors; the scripted adapter of the publish job answers the
// metrics calls.

export interface MetricsVariantRow {
  id: string;
  workspaceId: string;
  accountId: string;
  status: 'PUBLISHED' | 'DRAFT';
  isDryRun: boolean;
  externalPostId: string;
  externalUrl: string | null;
  publishedAt: Date;
  metricsNextAt: Date | null;
  metricsStep: number;
  externalDeletedAt: Date | null;
}

export interface SnapshotRow {
  variantId: string;
  accountId: string;
  platform: Platform;
  step: number;
  metrics: NormalizedPostMetrics;
  raw: unknown;
  mappingVersion: number;
  capturedAt: Date;
}

export interface LatestRow {
  variantId: string;
  metrics: NormalizedPostMetrics;
  engagements: number | null;
  capturedAt: Date;
}

interface State {
  variants: Map<string, MetricsVariantRow>;
  snapshots: SnapshotRow[];
  latest: Map<string, LatestRow>;
  daily: AccountDailyMetrics[];
  costs: ApiCostEntry[];
  targets: Map<string, PublishJobTarget>;
  connections: Map<string, SocialConnection>;
  timeZones: Map<string, string>;
}

const isDue = (variant: MetricsVariantRow, accountId: string, now: Date): boolean =>
  variant.accountId === accountId &&
  variant.status === 'PUBLISHED' &&
  !variant.isDryRun &&
  variant.metricsNextAt !== null &&
  variant.metricsNextAt.getTime() <= now.getTime();

export class InMemoryAnalytics implements AnalyticsUnitOfWork {
  state: State = {
    variants: new Map(),
    snapshots: [],
    latest: new Map(),
    daily: [],
    costs: [],
    targets: new Map(),
    connections: new Map(),
    timeZones: new Map([['ws-1', 'Europe/Berlin']]),
  };

  async run<T>(scope: AnalyticsScope, work: (store: AnalyticsStore) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.storeFor(scope));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  variant(id: string): MetricsVariantRow {
    const variant = this.state.variants.get(id);
    if (!variant) {
      throw new Error(`no variant ${id}`);
    }
    return variant;
  }

  private storeFor(scope: AnalyticsScope): AnalyticsStore {
    const state = (): State => this.state;
    const assertScope = (workspaceId: string): void => {
      if (workspaceId !== scope.workspaceId) {
        throw new ScopeViolation(`workspace ${workspaceId} is outside the scope`);
      }
    };
    const inScope = (workspaceId: string): MetricsVariantRow[] => {
      assertScope(workspaceId);
      return [...state().variants.values()].filter((variant) => variant.workspaceId === workspaceId);
    };
    const set = (variant: MetricsVariantRow, change: Partial<MetricsVariantRow>): void => {
      state().variants.set(variant.id, { ...variant, ...change });
    };
    return {
      targets: {
        find(workspaceId, accountId) {
          assertScope(workspaceId);
          const target = state().targets.get(accountId);
          return Promise.resolve(
            target?.account.workspaceId === workspaceId ? structuredClone(target) : null,
          );
        },
      },
      connections: {
        find(workspaceId, connectionId) {
          assertScope(workspaceId);
          const connection = state().connections.get(connectionId);
          return Promise.resolve(
            connection?.workspaceId === workspaceId ? structuredClone(connection) : null,
          );
        },
        storeRefresh(workspaceId, connectionId, version, tokens) {
          assertScope(workspaceId);
          const connection = state().connections.get(connectionId);
          if (connection?.version !== version) {
            return Promise.resolve(false);
          }
          state().connections.set(connectionId, {
            ...connection,
            accessTokenSealed: tokens.accessTokenSealed,
            refreshTokenSealed: tokens.refreshTokenSealed,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
            scopes: [...tokens.scopes],
            version: version + 1,
          });
          return Promise.resolve(true);
        },
      },
      workspaces: {
        timeZoneOf(workspaceId) {
          assertScope(workspaceId);
          return Promise.resolve(state().timeZones.get(workspaceId) ?? null);
        },
      },
      postMetrics: {
        claimDue(workspaceId, accountId, now, limit, leaseUntil) {
          const due = inScope(workspaceId)
            .filter((variant) => isDue(variant, accountId, now))
            .sort((a, b) => (a.metricsNextAt?.getTime() ?? 0) - (b.metricsNextAt?.getTime() ?? 0))
            .slice(0, limit);
          for (const variant of due) {
            set(variant, { metricsNextAt: leaseUntil });
          }
          return Promise.resolve(
            due.map(({ id, externalPostId, externalUrl, publishedAt, metricsStep }) => ({
              id,
              externalPostId,
              externalUrl,
              publishedAt,
              step: metricsStep,
            })),
          );
        },
        postpone(workspaceId, variantIds, at) {
          for (const variant of inScope(workspaceId).filter((row) => variantIds.includes(row.id))) {
            set(variant, { metricsNextAt: at });
          }
          return Promise.resolve();
        },
        postponeDue(workspaceId, accountId, now, at) {
          const due = inScope(workspaceId).filter((variant) => isDue(variant, accountId, now));
          for (const variant of due) {
            set(variant, { metricsNextAt: at });
          }
          return Promise.resolve(due.length);
        },
        endDue(workspaceId, accountId, now) {
          const due = inScope(workspaceId).filter((variant) => isDue(variant, accountId, now));
          for (const variant of due) {
            set(variant, { metricsNextAt: null });
          }
          return Promise.resolve(due.length);
        },
        record(workspaceId, account, capturedAt, polls) {
          assertScope(workspaceId);
          for (const poll of polls) {
            const variant = state().variants.get(poll.variantId);
            if (variant?.workspaceId !== workspaceId) {
              throw new ScopeViolation(`variant ${poll.variantId} is outside the scope`);
            }
            if (poll.kind === 'deleted') {
              set(variant, { externalDeletedAt: capturedAt, metricsNextAt: null });
              continue;
            }
            state().snapshots.push({
              variantId: poll.variantId,
              accountId: account.id,
              platform: account.platform,
              step: poll.step,
              metrics: poll.metrics,
              raw: poll.raw,
              mappingVersion: poll.mappingVersion,
              capturedAt,
            });
            const latest = state().latest.get(poll.variantId);
            if (!latest || latest.capturedAt.getTime() < capturedAt.getTime()) {
              state().latest.set(poll.variantId, {
                variantId: poll.variantId,
                metrics: poll.metrics,
                engagements: poll.engagements,
                capturedAt,
              });
            }
            set(variant, {
              metricsStep: poll.next?.step ?? poll.step + 1,
              metricsNextAt: poll.next?.at ?? null,
            });
          }
          return Promise.resolve();
        },
      },
      accountMetrics: {
        saveDaily(metrics) {
          assertScope(metrics.workspaceId);
          state().daily = [
            ...state().daily.filter(
              (row) => !(row.accountId === metrics.accountId && row.day === metrics.day),
            ),
            metrics,
          ];
          return Promise.resolve();
        },
      },
      costs: {
        record(entries) {
          for (const entry of entries) {
            assertScope(entry.workspaceId);
            state().costs.push(entry);
          }
          return Promise.resolve();
        },
      },
    };
  }
}

export interface AnalyticsTestbed extends AnalyticsJobDependencies {
  unitOfWork: InMemoryAnalytics;
  clock: MovingClock;
  adapter: ScriptedAdapter;
  warnings: string[];
}

/**
 * Account account-1 of workspace ws-1 on an active connection whose token runs for another hour,
 * with `variants` published variants whose first poll is due; prices only for x.post_read.
 */
export function createAnalyticsTestbed(
  options: { platform?: Platform; method?: ConnectionMethod; variants?: number } = {},
): AnalyticsTestbed {
  const platform = options.platform ?? 'LINKEDIN';
  const method = options.method ?? 'API';
  const clock = new MovingClock(NOW);
  const unitOfWork = new InMemoryAnalytics();
  const adapter = new ScriptedAdapter(platform, method, clock);
  const warnings: string[] = [];
  const bed: AnalyticsTestbed = {
    unitOfWork,
    clock,
    adapter,
    warnings,
    adapters: { resolve: () => Promise.resolve(adapter) },
    sealer: fakeSealer,
    locks: { withConnectionLock: (_connectionId, work) => work() },
    prices: { priceMicros: (operation) => (operation === 'x.post_read' ? 5_000 : null) },
    ids: sequentialIds('poll'),
    logger: {
      info: () => undefined,
      warn: (_fields, message) => {
        warnings.push(message);
      },
    },
  };
  const aad = (field: 'access_token' | 'refresh_token') => connectionSecretAad('ws-1', 'connection-1', field);
  const connection: SocialConnection = {
    id: 'connection-1',
    workspaceId: 'ws-1',
    platform,
    method,
    status: 'ACTIVE',
    externalUserId: 'user-1',
    displayName: 'Mira',
    accessTokenSealed: sealed('access-1', aad('access_token')),
    refreshTokenSealed: sealed('refresh-1', aad('refresh_token')),
    accessTokenExpiresAt: new Date(NOW + 60 * 60 * 1000),
    refreshTokenExpiresAt: new Date(NOW + 30 * 24 * 60 * 60 * 1000),
    scopes: [],
    version: 2,
  };
  unitOfWork.state.connections.set('connection-1', connection);
  unitOfWork.state.targets.set('account-1', {
    account: {
      id: 'account-1',
      workspaceId: 'ws-1',
      connectionId: 'connection-1',
      platform,
      type: 'PROFILE',
      externalId: 'user-1',
      name: 'Mira',
      handle: null,
      settings: {},
    },
    disconnectedAt: null,
    accessTokenSealed: null,
    connection,
  });
  for (let index = 1; index <= (options.variants ?? 2); index += 1) {
    addPublishedVariant(unitOfWork, `variant-${String(index)}`, {
      publishedAt: new Date(NOW - 2 * 60 * 60 * 1000),
      metricsNextAt: new Date(NOW - 60 * 60 * 1000 + index),
    });
  }
  return bed;
}

export function addPublishedVariant(
  unitOfWork: InMemoryAnalytics,
  id: string,
  row: Partial<MetricsVariantRow> = {},
): void {
  unitOfWork.state.variants.set(id, {
    id,
    workspaceId: 'ws-1',
    accountId: 'account-1',
    status: 'PUBLISHED',
    isDryRun: false,
    externalPostId: `post-${id}`,
    externalUrl: null,
    publishedAt: new Date(NOW - 2 * 60 * 60 * 1000),
    metricsNextAt: new Date(NOW - 60 * 60 * 1000),
    metricsStep: 0,
    externalDeletedAt: null,
    ...row,
  });
}

export const jobOf = (overrides: Partial<{ accountId: string; signal: AbortSignal }> = {}) => ({
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  accountId: 'account-1',
  signal: new AbortController().signal,
  ...overrides,
});
