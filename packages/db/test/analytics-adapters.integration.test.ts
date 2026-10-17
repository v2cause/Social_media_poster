import { randomUUID } from 'node:crypto';

import {
  CollectAccountMetrics,
  CollectPostMetrics,
  connectionSecretAad,
  type AccountMetricsResult,
  type AdapterContext,
  type AnalyticsJobDependencies,
  type DateRange,
  type ExternalPostRef,
  type PostMetricsResult,
  type RefreshOutcome,
  type SecretSealer,
  type SocialPlatformAdapter,
} from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  createSystemPrismaClient,
  PrismaAnalyticsUnitOfWork,
  PrismaMetricsPlanScanner,
  type PrismaClient,
  type SystemPrismaClient,
} from '../src';

// Guide step 5.2 on PostgreSQL: the collector of the core claims the due variants of an account
// as app_user under row-level security, stores snapshots, the latest numbers and the next poll
// without touching the version of the variant, marks posts deleted on the platform and books the
// read costs of X; the planner finds due accounts and missing days across workspaces.

const org = randomUUID();
const workspace = randomUUID();
const otherWorkspace = randomUUID();
const NOW = new Date('2026-10-16T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const sealer: SecretSealer = {
  seal: (plaintext, aad) => Promise.resolve(new TextEncoder().encode(`${aad}|${plaintext}`)),
  open(sealed, aad) {
    const text = new TextDecoder().decode(sealed);
    return text.startsWith(`${aad}|`)
      ? Promise.resolve(text.slice(aad.length + 1))
      : Promise.reject(new Error('INVALID'));
  },
};

/** Answers metrics from a map of impressions per post; a post missing there is deleted. */
class MetricsAdapter implements SocialPlatformAdapter {
  readonly method = 'API' as const;
  readonly connector = {
    scopes: [],
    usesPkce: false,
    authorizationUrl: () => 'https://platform.example/authorize',
    exchangeCode: () => Promise.reject(new Error('not used')),
    listConnectableAccounts: () => Promise.resolve([]),
    revoke: () => Promise.resolve(),
  };
  impressions = new Map<string, number>();

  constructor(readonly platform: 'X' | 'LINKEDIN') {}

  capabilities(): never {
    throw new Error('not used');
  }
  validatePost(): never[] {
    return [];
  }
  refreshCredentials(): Promise<RefreshOutcome> {
    return Promise.resolve({ status: 'not_needed' });
  }
  publish(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  reconcile(): Promise<null> {
    return Promise.resolve(null);
  }
  deletePost(): Promise<void> {
    return Promise.resolve();
  }
  async fetchPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    if (this.platform === 'X') {
      await ctx.costs.record({ operation: 'x.post_read', units: refs.length });
    }
    return refs.map((ref): PostMetricsResult => {
      const impressions = this.impressions.get(ref.externalPostId);
      return impressions === undefined
        ? { kind: 'deleted', externalPostId: ref.externalPostId }
        : {
            kind: 'metrics',
            externalPostId: ref.externalPostId,
            metrics: {
              impressions,
              reach: null,
              views: null,
              likes: 4,
              comments: 1,
              shares: 0,
              clicks: null,
              saves: null,
            },
            raw: { impressions },
            mappingVersion: 2,
          };
    });
  }
  fetchAccountMetrics(_range: DateRange, ctx: AdapterContext): Promise<AccountMetricsResult> {
    return Promise.resolve({
      followers: ctx.account.name === 'Mira' ? 812 : 0,
      reach: null,
      profileViews: 40,
      raw: { followers: 812 },
      mappingVersion: 1,
    });
  }
}

describe('analytics adapters on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;
  let system: SystemPrismaClient | undefined;

  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    if (!database) {
      throw new Error('database not ready');
    }
    const connection = await database.connectAs('app_system');
    try {
      return (await connection.query(sql, values)).rows as T[];
    } finally {
      await connection.end();
    }
  };

  const depsFor = (adapter: MetricsAdapter, now = NOW): AnalyticsJobDependencies => {
    if (!base) {
      throw new Error('database not ready');
    }
    return {
      unitOfWork: new PrismaAnalyticsUnitOfWork(base),
      adapters: { resolve: () => Promise.resolve(adapter) },
      sealer,
      locks: { withConnectionLock: (_id, work) => work() },
      prices: { priceMicros: (operation) => (operation === 'x.post_read' ? 5_000 : null) },
      clock: { now: () => now },
      ids: { newId: () => randomUUID() },
      logger: { info: () => undefined, warn: () => undefined },
    };
  };

  /** An account on an active connection in the workspace. */
  const seedAccount = async (
    platform: 'X' | 'LINKEDIN',
    options: { ws?: string; status?: string; disconnected?: boolean } = {},
  ): Promise<string> => {
    const ws = options.ws ?? workspace;
    const connectionId = randomUUID();
    const accountId = randomUUID();
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, status, external_user_id, display_name,
                                      access_token_sealed, access_token_expires_at, updated_at)
       VALUES ($1, $2, $3, 'API', $4, $5, 'Mira', $6, $7, now())`,
      [
        connectionId,
        ws,
        platform,
        options.status ?? 'ACTIVE',
        `user-${connectionId}`,
        Buffer.from(`${connectionSecretAad(ws, connectionId, 'access_token')}|access-1`),
        new Date(NOW.getTime() + 24 * HOUR),
      ],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name,
                                   disconnected_at, updated_at)
       VALUES ($1, $2, $3, $4, 'PROFILE', $5, 'Mira', $6, now())`,
      [accountId, ws, connectionId, platform, `ext-${accountId}`, options.disconnected ? NOW : null],
    );
    return accountId;
  };

  /** A published variant of the account whose next poll is due at `dueAt`. */
  const seedPublished = async (
    accountId: string,
    platform: 'X' | 'LINKEDIN',
    options: { ws?: string; dueAt?: Date | null; publishedAt?: Date; step?: number } = {},
  ): Promise<string> => {
    const ws = options.ws ?? workspace;
    const postId = randomUUID();
    const variantId = randomUUID();
    await query(`INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`, [
      postId,
      ws,
    ]);
    await query(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, social_account_id, status,
                                 version, published_at, external_post_id, metrics_next_at, metrics_step,
                                 updated_at)
       VALUES ($1, $2, $3, $4, 't1', $5, 'PUBLISHED', 7, $6, $7, $8, $9, '2026-10-01T00:00:00Z')`,
      [
        variantId,
        ws,
        postId,
        platform,
        accountId,
        options.publishedAt ?? new Date(NOW.getTime() - 2 * HOUR),
        `post-${variantId}`,
        options.dueAt === undefined ? new Date(NOW.getTime() - HOUR) : options.dueAt,
        options.step ?? 0,
      ],
    );
    return variantId;
  };

  const variantRow = async (id: string) =>
    (
      await query<{
        metrics_step: number;
        metrics_next_at: Date | null;
        external_deleted_at: Date | null;
        version: number;
        updated_at: Date;
      }>(
        `SELECT metrics_step, metrics_next_at, external_deleted_at, version, updated_at
           FROM post_variant WHERE id = $1`,
        [id],
      )
    )[0];

  const job = (accountId: string) => ({
    organizationId: org,
    workspaceId: workspace,
    accountId,
    signal: new AbortController().signal,
  });

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'analytics-a', 'A', 'Europe/Berlin', 'de', now()),
              ($3, $2, 'analytics-b', 'B', 'America/New_York', 'en', now())`,
      [workspace, org, otherWorkspace],
    );
    base = createPrismaClient(database.url('app_user'));
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await system?.$disconnect();
    await database?.stop();
  });

  it('stores snapshot, latest numbers and next poll without touching the version of the variant', async () => {
    const accountId = await seedAccount('LINKEDIN');
    const first = await seedPublished(accountId, 'LINKEDIN');
    const later = await seedPublished(accountId, 'LINKEDIN', { dueAt: new Date(NOW.getTime() + HOUR) });
    const adapter = new MetricsAdapter('LINKEDIN');
    adapter.impressions.set(`post-${first}`, 240);

    await expect(new CollectPostMetrics(depsFor(adapter)).execute(job(accountId))).resolves.toEqual({
      polled: 1,
      deleted: 0,
      postponed: 0,
      ended: 0,
    });

    const snapshots = await query<Record<string, unknown>>(
      `SELECT step, impressions, reach, likes, comments, raw, mapping_version, captured_at
         FROM metric_snapshot WHERE variant_id = $1`,
      [first],
    );
    expect(snapshots).toEqual([
      {
        step: 0,
        impressions: 240,
        reach: null,
        likes: 4,
        comments: 1,
        raw: { impressions: 240 },
        mapping_version: 2,
        captured_at: NOW,
      },
    ]);
    const [latest] = await query<Record<string, unknown>>(
      `SELECT impressions, engagements, captured_at, published_at FROM post_metric_latest WHERE variant_id = $1`,
      [first],
    );
    expect(latest).toEqual({
      impressions: 240,
      engagements: 5,
      captured_at: NOW,
      published_at: new Date(NOW.getTime() - 2 * HOUR),
    });
    expect(await variantRow(first)).toEqual({
      metrics_step: 1,
      metrics_next_at: new Date(NOW.getTime() - 2 * HOUR + 24 * HOUR),
      external_deleted_at: null,
      version: 7,
      updated_at: new Date('2026-10-01T00:00:00Z'),
    });
    expect((await variantRow(later))?.metrics_step).toBe(0);
  });

  it('keeps newer latest numbers and marks posts deleted on the platform', async () => {
    const accountId = await seedAccount('LINKEDIN');
    const kept = await seedPublished(accountId, 'LINKEDIN');
    const gone = await seedPublished(accountId, 'LINKEDIN');
    const adapter = new MetricsAdapter('LINKEDIN');
    adapter.impressions.set(`post-${kept}`, 300);
    await new CollectPostMetrics(depsFor(adapter)).execute(job(accountId));

    // An older poll of the same variant arrives late: the snapshot stays, the latest numbers too.
    await query(`UPDATE post_variant SET metrics_next_at = $2 WHERE id = $1`, [
      kept,
      new Date(NOW.getTime() - HOUR),
    ]);
    adapter.impressions.set(`post-${kept}`, 100);
    await new CollectPostMetrics(depsFor(adapter, new Date(NOW.getTime() - 30 * 60 * 1000))).execute(
      job(accountId),
    );
    expect(await query(`SELECT impressions FROM post_metric_latest WHERE variant_id = $1`, [kept])).toEqual([
      { impressions: 300 },
    ]);
    expect(
      await query(`SELECT count(*)::int AS n FROM metric_snapshot WHERE variant_id = $1`, [kept]),
    ).toEqual([{ n: 2 }]);
    expect(await variantRow(gone)).toMatchObject({ external_deleted_at: NOW, metrics_next_at: null });
  });

  it('lets a second run skip the variants a first run claimed', async () => {
    const accountId = await seedAccount('X');
    await seedPublished(accountId, 'X');
    const unitOfWork = new PrismaAnalyticsUnitOfWork(base as PrismaClient);
    const scope = { organizationId: org, workspaceId: workspace };
    const lease = new Date(NOW.getTime() + 15 * 60 * 1000);
    const [first, second] = await Promise.all([
      unitOfWork.run(scope, (store) => store.postMetrics.claimDue(workspace, accountId, NOW, 10, lease)),
      unitOfWork.run(scope, (store) => store.postMetrics.claimDue(workspace, accountId, NOW, 10, lease)),
    ]);
    expect([first.length, second.length].sort()).toEqual([0, 1]);
  });

  it('books the posts X reads in the cost ledger of the organization', async () => {
    const accountId = await seedAccount('X');
    const a = await seedPublished(accountId, 'X', { publishedAt: new Date(NOW.getTime() - 30 * HOUR) });
    const b = await seedPublished(accountId, 'X', { publishedAt: new Date(NOW.getTime() - 30 * HOUR) });
    const adapter = new MetricsAdapter('X');
    adapter.impressions.set(`post-${a}`, 10);
    adapter.impressions.set(`post-${b}`, 20);

    await new CollectPostMetrics(depsFor(adapter)).execute(job(accountId));
    expect(
      await query(
        `SELECT operation, units, cost_micros::int AS cost, source_type FROM api_cost_record
          WHERE social_account_id = $1`,
        [accountId],
      ),
    ).toEqual([{ operation: 'x.post_read', units: 2, cost: 10_000, source_type: 'metrics_poll' }]);
    // X polls after 24 and 72 hours: the poll after 30 hours leads to the one after 72.
    expect((await variantRow(a))?.metrics_next_at).toEqual(new Date(NOW.getTime() - 30 * HOUR + 72 * HOUR));
  });

  it('stores the numbers of an account per day and replaces them on another poll of the day', async () => {
    const accountId = await seedAccount('LINKEDIN');
    const collect = new CollectAccountMetrics(depsFor(new MetricsAdapter('LINKEDIN')));

    await expect(collect.execute({ ...job(accountId), day: '2026-10-15' })).resolves.toEqual({ saved: true });
    await collect.execute({ ...job(accountId), day: '2026-10-15' });
    expect(
      await query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, followers, reach, profile_views
           FROM account_metric_snapshot WHERE social_account_id = $1`,
        [accountId],
      ),
    ).toEqual([{ day: '2026-10-15', followers: 812, reach: null, profile_views: 40 }]);
  });

  it('finds the accounts with due polls and the missing days of the accounts across workspaces', async () => {
    const scanner = new PrismaMetricsPlanScanner(system as SystemPrismaClient);
    const due = await seedAccount('LINKEDIN', { ws: otherWorkspace });
    await seedPublished(due, 'LINKEDIN', { ws: otherWorkspace });
    await seedPublished(due, 'LINKEDIN', { ws: otherWorkspace });
    const notDue = await seedAccount('LINKEDIN', { ws: otherWorkspace });
    await seedPublished(notDue, 'LINKEDIN', { ws: otherWorkspace, dueAt: new Date(NOW.getTime() + HOUR) });

    const accounts = await scanner.dueAccounts(NOW, 1_000);
    expect(accounts.filter((account) => account.accountId === due)).toEqual([
      { accountId: due, workspaceId: otherWorkspace, organizationId: org },
    ]);
    expect(accounts.some((account) => account.accountId === notDue)).toBe(false);

    // 12:00 UTC is 08:00 in New York: past 03:00, so the numbers of October 15 are due.
    const disconnected = await seedAccount('LINKEDIN', { ws: otherWorkspace, disconnected: true });
    const reauth = await seedAccount('LINKEDIN', { ws: otherWorkspace, status: 'NEEDS_REAUTH' });
    const days = await scanner.accountDaysDue(NOW, 1_000);
    expect(days.filter((day) => day.accountId === due)).toEqual([
      { accountId: due, workspaceId: otherWorkspace, organizationId: org, day: '2026-10-15' },
    ]);
    expect(days.some((day) => day.accountId === disconnected || day.accountId === reauth)).toBe(false);
    // At 06:00 UTC it is 02:00 in New York: not yet.
    const early = await scanner.accountDaysDue(new Date('2026-10-16T06:00:00Z'), 1_000);
    expect(early.some((day) => day.accountId === due)).toBe(false);

    // Once the day is there, it is no longer missing.
    await new CollectAccountMetrics({
      ...depsFor(new MetricsAdapter('LINKEDIN')),
    }).execute({
      organizationId: org,
      workspaceId: otherWorkspace,
      accountId: due,
      day: '2026-10-15',
      signal: new AbortController().signal,
    });
    const after = await scanner.accountDaysDue(NOW, 1_000);
    expect(after.some((day) => day.accountId === due)).toBe(false);
  });
});
