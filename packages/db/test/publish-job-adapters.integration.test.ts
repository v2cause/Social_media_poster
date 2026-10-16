import { randomUUID } from 'node:crypto';

import {
  connectionSecretAad,
  PlatformError,
  PublishVariant,
  type AdapterContext,
  type PublishJobDependencies,
  type PublishJobInput,
  type PublishRequest,
  type PublishResult,
  type RefreshOutcome,
  type SecretSealer,
  type SocialPlatformAdapter,
} from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient, PrismaPublishJobUnitOfWork, type PrismaClient } from '../src';

// Guide step 4.8 on PostgreSQL: the publish job of the core claims, runs and ends a variant as
// app_user under row-level security. The claim locks the row, so two jobs of the same variant
// never both send; the token refresh, the cost ledger and the attempt log land in the database.

const org = randomUUID();
const otherOrg = randomUUID();
const workspace = randomUUID();
const otherWorkspace = randomUUID();
const NOW = new Date('2026-10-16T12:00:00Z');

/** Seals as "aad|plaintext", like the fake of the core tests. */
const sealer: SecretSealer = {
  seal: (plaintext, aad) => Promise.resolve(new TextEncoder().encode(`${aad}|${plaintext}`)),
  open(sealed, aad) {
    const text = new TextDecoder().decode(sealed);
    return text.startsWith(`${aad}|`)
      ? Promise.resolve(text.slice(aad.length + 1))
      : Promise.reject(new Error('INVALID'));
  },
};

/** An adapter that publishes at once, or waits for a gate; it counts its calls. */
class TestAdapter implements SocialPlatformAdapter {
  readonly method = 'API' as const;
  readonly connector = {
    scopes: [],
    usesPkce: false,
    authorizationUrl: () => 'https://platform.example/authorize',
    exchangeCode: () => Promise.reject(new Error('not used')),
    listConnectableAccounts: () => Promise.resolve([]),
    revoke: () => Promise.resolve(),
  };
  readonly calls = { publish: 0, refresh: 0 };
  readonly requests: PublishRequest[] = [];
  gate: Promise<void> = Promise.resolve();
  refreshAnswer: RefreshOutcome | Error = {
    status: 'refreshed',
    tokens: {
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
      refreshTokenExpiresAt: null,
      scopes: ['tweet.write'],
    },
  };
  publishAnswer: Error | null = null;

  constructor(readonly platform: 'X' | 'LINKEDIN') {}

  capabilities(): never {
    throw new Error('not used');
  }
  validatePost(): never[] {
    return [];
  }
  refreshCredentials(): Promise<RefreshOutcome> {
    this.calls.refresh += 1;
    return this.refreshAnswer instanceof Error
      ? Promise.reject(this.refreshAnswer)
      : Promise.resolve(this.refreshAnswer);
  }
  async publish(request: PublishRequest, ctx: AdapterContext): Promise<PublishResult> {
    this.calls.publish += 1;
    this.requests.push(request);
    await this.gate;
    if (this.publishAnswer) {
      throw this.publishAnswer;
    }
    if (this.platform === 'X') {
      await ctx.costs.record({ operation: 'x.post_create' });
    }
    return {
      externalPostId: `post-${String(this.calls.publish)}`,
      externalUrl: null,
      publishedAt: NOW,
      meta: { containerId: 'c-1' },
    };
  }
  reconcile(): Promise<null> {
    return Promise.resolve(null);
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

describe('publish job adapters on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;

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

  const depsFor = (adapter: TestAdapter): PublishJobDependencies => {
    if (!base) {
      throw new Error('database not ready');
    }
    return {
      unitOfWork: new PrismaPublishJobUnitOfWork(base),
      adapters: { resolve: () => Promise.resolve(adapter) },
      sealer,
      locks: { withConnectionLock: (_id, work) => work() },
      storage: { signedGetUrl: (key) => Promise.resolve(`https://storage.example/${key}?signature=s`) },
      prices: { priceMicros: (operation) => (operation === 'x.post_create' ? 15_000 : null) },
      hash: (value) => `hash-${String(value.length)}`,
      clock: { now: () => NOW },
      ids: { newId: () => randomUUID() },
      logger: { info: () => undefined, warn: () => undefined },
      dryRunLive: false,
    };
  };

  /** A queued variant on an account of its own, with an active connection. */
  const seedVariant = async (
    platform: 'X' | 'LINKEDIN',
    options: { accessExpiresAt?: Date; scheduledAt?: Date; text?: string } = {},
  ): Promise<{ variantId: string; connectionId: string; accountId: string }> => {
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const postId = randomUUID();
    const variantId = randomUUID();
    const aad = (field: 'access_token' | 'refresh_token') =>
      connectionSecretAad(workspace, connectionId, field);
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                      access_token_sealed, refresh_token_sealed, access_token_expires_at,
                                      scopes, version, updated_at)
       VALUES ($1, $2, $3, 'API', $4, 'Mira', $5, $6, $7, '{tweet.read}', 4, now())`,
      [
        connectionId,
        workspace,
        platform,
        `user-${connectionId}`,
        Buffer.from(`${aad('access_token')}|access-1`),
        Buffer.from(`${aad('refresh_token')}|refresh-1`),
        options.accessExpiresAt ?? new Date(NOW.getTime() + 60 * 60 * 1000),
      ],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name,
                                   settings, updated_at)
       VALUES ($1, $2, $3, $4, 'PROFILE', $5, 'Mira', '{"latencyMs": 5}', now())`,
      [accountId, workspace, connectionId, platform, `ext-${accountId}`],
    );
    await query(
      `INSERT INTO post (id, workspace_id, brief, language, updated_at) VALUES ($1, $2, 'Brief', 'de', now())`,
      [postId, workspace],
    );
    await query(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, text, hashtags,
                                 social_account_id, status, version, schedule_version, scheduled_at,
                                 queued_at, updated_at)
       VALUES ($1, $2, $3, $4, 't1', $5, '{Kiel}', $6, 'QUEUED', 3, 1, $7, $7, now())`,
      [
        variantId,
        workspace,
        postId,
        platform,
        options.text ?? 'Wir suchen Verstärkung.',
        accountId,
        options.scheduledAt ?? new Date(NOW.getTime() - 60_000),
      ],
    );
    return { variantId, connectionId, accountId };
  };

  const jobFor = (variantId: string, overrides: Partial<PublishJobInput> = {}): PublishJobInput => ({
    organizationId: org,
    workspaceId: workspace,
    variantId,
    scheduleVersion: 1,
    trigger: 'schedule',
    lastAttempt: false,
    owner: `worker:${randomUUID()}`,
    signal: new AbortController().signal,
    ...overrides,
  });

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`, [
      org,
      otherOrg,
    ]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'publish-a', 'A', 'Europe/Berlin', 'de', now()),
              ($3, $4, 'publish-b', 'B', 'Europe/Berlin', 'de', now())`,
      [workspace, org, otherWorkspace, otherOrg],
    );
    base = createPrismaClient(database.url('app_user'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await database?.stop();
  });

  it('publishes a queued variant with attempt, cost record and events', async () => {
    const { variantId, accountId } = await seedVariant('X');
    const adapter = new TestAdapter('X');

    await expect(new PublishVariant(depsFor(adapter)).execute(jobFor(variantId))).resolves.toEqual({
      kind: 'published',
      reconciled: false,
      dryRun: false,
    });

    const [variant] = await query<Record<string, unknown>>(
      `SELECT status, version, external_post_id, lease_owner, lease_until, metrics_next_at, content_hash,
              is_dry_run, failure_code
         FROM post_variant WHERE id = $1`,
      [variantId],
    );
    // Claim, lease extension before the request and the end each raise the version.
    expect(variant).toEqual({
      status: 'PUBLISHED',
      version: 6,
      external_post_id: 'post-1',
      lease_owner: null,
      lease_until: null,
      metrics_next_at: new Date('2026-10-17T12:00:00Z'),
      content_hash: adapter.requests[0]?.contentHash,
      is_dry_run: false,
      failure_code: null,
    });
    const [attempt] = await query<Record<string, unknown>>(
      `SELECT id, schedule_version, attempt_number, trigger, outcome, external_post_id, meta, finished_at
         FROM publish_attempt WHERE variant_id = $1`,
      [variantId],
    );
    expect(attempt).toMatchObject({
      schedule_version: 1,
      attempt_number: 1,
      trigger: 'schedule',
      outcome: 'PUBLISHED',
      external_post_id: 'post-1',
      meta: { containerId: 'c-1' },
      finished_at: NOW,
    });
    expect(
      await query(
        `SELECT organization_id, workspace_id, social_account_id, platform, operation, units, cost_micros,
                source_type, source_id
           FROM api_cost_record WHERE source_id = $1`,
        [attempt?.id],
      ),
    ).toEqual([
      {
        organization_id: org,
        workspace_id: workspace,
        social_account_id: accountId,
        platform: 'X',
        operation: 'x.post_create',
        units: 1,
        cost_micros: '15000',
        source_type: 'publish_attempt',
        source_id: attempt?.id,
      },
    ]);
    const events = await query<{ status: string }>(
      `SELECT payload->>'status' AS status FROM outbox_event
        WHERE payload->>'variantId' = $1 ORDER BY created_at, id`,
      [variantId],
    );
    expect(events.map((event) => event.status)).toEqual(['PUBLISHING', 'PUBLISHED']);
  });

  it('lets only one of two jobs of the same variant send: the other one waits for the lease', async () => {
    const { variantId } = await seedVariant('LINKEDIN');
    const adapter = new TestAdapter('LINKEDIN');
    let open: () => void = () => undefined;
    adapter.gate = new Promise((resolve) => {
      open = resolve;
    });
    const deps = depsFor(adapter);

    const first = new PublishVariant(deps).execute(jobFor(variantId));
    const second = new PublishVariant(deps).execute(jobFor(variantId));
    // Whichever claims first sends; the other meets its live lease.
    const busy = await Promise.race([first, second]);
    open();
    const outcomes = await Promise.all([first, second]);

    expect(busy).toMatchObject({ kind: 'busy' });
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['busy', 'published']);
    expect(adapter.calls.publish).toBe(1);
    expect(await query('SELECT outcome FROM publish_attempt WHERE variant_id = $1', [variantId])).toEqual([
      { outcome: 'PUBLISHED' },
    ]);
  });

  it('renews a token that runs out soon and stores it sealed with a new version', async () => {
    const { variantId, connectionId } = await seedVariant('X', {
      accessExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    const adapter = new TestAdapter('X');

    await new PublishVariant(depsFor(adapter)).execute(jobFor(variantId));

    expect(adapter.calls.refresh).toBe(1);
    const [connection] = await query<Record<string, unknown>>(
      `SELECT status, version, access_token_sealed, refresh_token_sealed, access_token_expires_at, scopes,
              last_refreshed_at
         FROM social_connection WHERE id = $1`,
      [connectionId],
    );
    const aad = (field: 'access_token' | 'refresh_token') =>
      connectionSecretAad(workspace, connectionId, field);
    expect(connection).toEqual({
      status: 'ACTIVE',
      version: 5,
      access_token_sealed: Buffer.from(`${aad('access_token')}|access-2`),
      refresh_token_sealed: Buffer.from(`${aad('refresh_token')}|refresh-2`),
      access_token_expires_at: new Date('2026-10-16T14:00:00Z'),
      scopes: ['tweet.write'],
      last_refreshed_at: NOW,
    });
  });

  it('marks the connection NEEDS_REAUTH when the platform refuses token and refresh', async () => {
    const { variantId, connectionId } = await seedVariant('X');
    const adapter = new TestAdapter('X');
    adapter.publishAnswer = new PlatformError('AUTH_EXPIRED', 'HTTP 401');
    adapter.refreshAnswer = new PlatformError('AUTH_EXPIRED', 'refresh refused');

    await expect(new PublishVariant(depsFor(adapter)).execute(jobFor(variantId))).resolves.toEqual({
      kind: 'failed',
      code: 'REAUTH_REQUIRED',
    });

    expect(
      await query('SELECT status, status_reason FROM social_connection WHERE id = $1', [connectionId]),
    ).toEqual([{ status: 'NEEDS_REAUTH', status_reason: 'REFRESH_FAILED' }]);
    expect(await query('SELECT status, failure_code FROM post_variant WHERE id = $1', [variantId])).toEqual([
      { status: 'FAILED', failure_code: 'REAUTH_REQUIRED' },
    ]);
  });

  it('fails a variant whose job comes more than 6 h late', async () => {
    const { variantId } = await seedVariant('LINKEDIN', {
      scheduledAt: new Date(NOW.getTime() - 7 * 60 * 60 * 1000),
    });

    await expect(
      new PublishVariant(depsFor(new TestAdapter('LINKEDIN'))).execute(
        jobFor(variantId, { trigger: 'sweep' }),
      ),
    ).resolves.toEqual({ kind: 'failed', code: 'MISSED_WINDOW' });
    expect(
      await query('SELECT status, failure_code, version FROM post_variant WHERE id = $1', [variantId]),
    ).toEqual([{ status: 'FAILED', failure_code: 'MISSED_WINDOW', version: 4 }]);
  });

  it('sends the rendition of the platform with the alt text of its use or of the asset', async () => {
    const { variantId } = await seedVariant('LINKEDIN');
    const [own, inherited] = [randomUUID(), randomUUID()];
    for (const [index, assetId] of [own, inherited].entries()) {
      await query(
        `INSERT INTO media_asset (id, workspace_id, status, file_name, declared_mime_type, declared_size,
                                  storage_key, mime_type, width, height, alt_text, updated_at)
         VALUES ($1, $2, 'READY', 'team.jpg', 'image/jpeg', 1000, $3, 'image/jpeg', 2400, 1600, 'Asset', now())`,
        [assetId, workspace, `ws/${workspace}/assets/${assetId}/original`],
      );
      await query(
        `INSERT INTO media_rendition (id, workspace_id, asset_id, profile, crop_hash, storage_key, mime_type,
                                      width, height, size_bytes)
         VALUES ($1, $2, $3, 'linkedin_image', $4, $5, 'image/jpeg', 2048, 1365, 400000)`,
        [
          randomUUID(),
          workspace,
          assetId,
          index === 0 ? 'x0y0w1200h800' : 'full',
          `ws/${workspace}/assets/${assetId}/linkedin_image`,
        ],
      );
      await query(
        `INSERT INTO post_media (id, workspace_id, variant_id, asset_id, position, crop, alt_text, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          randomUUID(),
          workspace,
          variantId,
          assetId,
          index,
          index === 0 ? JSON.stringify({ x: 0, y: 0, width: 1200, height: 800 }) : null,
          index === 0 ? 'Das Team' : null,
        ],
      );
    }
    const adapter = new TestAdapter('LINKEDIN');

    await new PublishVariant(depsFor(adapter)).execute(jobFor(variantId));

    expect(adapter.requests[0]?.media).toEqual([
      expect.objectContaining({
        url: `https://storage.example/ws/${workspace}/assets/${own}/linkedin_image?signature=s`,
        altText: 'Das Team',
        width: 2048,
      }),
      expect.objectContaining({ altText: 'Asset' }),
    ]);
  });

  it('finds no variant of another workspace', async () => {
    const { variantId } = await seedVariant('LINKEDIN');

    await expect(
      new PublishVariant(depsFor(new TestAdapter('LINKEDIN'))).execute(
        jobFor(variantId, { organizationId: otherOrg, workspaceId: otherWorkspace }),
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'NOT_FOUND' });
  });

  it('books a cost once per source and operation, and lists the open attempts', async () => {
    const { variantId, accountId } = await seedVariant('X');
    if (!base) {
      throw new Error('database not ready');
    }
    const unit = new PrismaPublishJobUnitOfWork(base);
    const sourceId = randomUUID();
    const entry = {
      organizationId: org,
      workspaceId: workspace,
      socialAccountId: accountId,
      platform: 'X' as const,
      operation: 'x.post_read',
      units: 5,
      costMicros: 25_000,
      sourceType: 'publish_attempt' as const,
      sourceId,
    };
    const scope = { organizationId: org, workspaceId: workspace };
    await unit.run(scope, (store) => store.costs.record([entry]));
    await unit.run(scope, (store) => store.costs.record([{ ...entry, units: 9 }]));
    expect(await query('SELECT units FROM api_cost_record WHERE source_id = $1', [sourceId])).toEqual([
      { units: 5 },
    ]);

    for (const [number, outcome] of (['STARTED', 'PUBLISHED', 'UNKNOWN'] as const).entries()) {
      await query(
        `INSERT INTO publish_attempt (id, workspace_id, variant_id, schedule_version, attempt_number, trigger,
                                      outcome, lease_owner, started_at)
         VALUES ($1, $2, $3, 1, $4, 'schedule', $5, 'w', $6)`,
        [randomUUID(), workspace, variantId, number + 1, outcome, new Date(NOW.getTime() + number * 1000)],
      );
    }
    await expect(unit.run(scope, (store) => store.attempts.unclear(workspace, variantId))).resolves.toEqual([
      { scheduleVersion: 1, outcome: 'STARTED', startedAt: NOW },
      { scheduleVersion: 1, outcome: 'UNKNOWN', startedAt: new Date(NOW.getTime() + 2000) },
    ]);
  });
});
