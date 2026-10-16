import { randomUUID } from 'node:crypto';

import {
  CostCalculator,
  fixedQuotaLimits,
  QuotaExceededError,
  QuotaService,
  type Clock,
  type QuotaKey,
} from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient, PrismaPriceCatalog, PrismaQuotaStore, type PrismaClient } from '../src';

// Guide step 2.6: reservations are atomic against the limit, also in parallel; the ledger books
// every source once; the price catalog reads the price book of the migrations.

const orgA = randomUUID();
const orgB = randomUUID();
const workspaceA = randomUUID();
const october: Clock = { now: () => new Date('2026-10-16T12:00:00Z') };
const keyOf = (organizationId: string): QuotaKey => ({
  organizationId,
  meter: 'ai_micros',
  periodStart: new Date('2026-10-01T00:00:00Z'),
});

describe('usage on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;

  const client = (): PrismaClient => {
    if (!base) {
      throw new Error('database not ready');
    }
    return base;
  };
  // app_system reads across tenants; the owner writes the price book like a migration.
  const as = async <T>(
    role: 'app_system' | 'app_migrator',
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    if (!database) {
      throw new Error('database not ready');
    }
    const connection = await database.connectAs(role);
    try {
      return (await connection.query(sql, params)).rows as T[];
    } finally {
      await connection.end();
    }
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    const system = await database.connectAs('app_system');
    try {
      await system.query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`,
        [orgA, orgB],
      );
      await system.query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $2, 'usage-a', 'A', 'Europe/Berlin', 'de', now())`,
        [workspaceA, orgA],
      );
    } finally {
      await system.end();
    }
    base = createPrismaClient(database.url('app_user'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await database?.stop();
  });

  it('never passes the limit with parallel reservations', async () => {
    const quota = new QuotaService({
      store: new PrismaQuotaStore(client()),
      limits: fixedQuotaLimits({ ai_micros: 1_000n }),
      clock: october,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () =>
        quota.reserve({ organizationId: orgA, workspaceId: workspaceA }, 'ai_micros', 30n),
      ),
    );

    const refused = results.filter((result) => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(33);
    expect(refused).toHaveLength(7);
    for (const result of refused) {
      expect(result.reason).toBeInstanceOf(QuotaExceededError);
    }
    expect(await quota.usage(orgA, 'ai_micros')).toEqual({
      used: 990n,
      limit: 1_000n,
      periodStart: new Date('2026-10-01T00:00:00Z'),
    });
    // The other organization has its own counter.
    expect(await quota.usage(orgB, 'ai_micros')).toMatchObject({ used: 0n });
  });

  it('books every source once and moves the counter by the difference to the reservation', async () => {
    const store = new PrismaQuotaStore(client());
    const before = await store.current(keyOf(orgA));
    const sourceId = randomUUID();
    const settlement = {
      workspaceId: workspaceA,
      reserved: 30n,
      quantity: 12n,
      sourceType: 'ai_generation',
      sourceId,
    };

    expect(await store.settle(keyOf(orgA), settlement)).toBe(true);
    expect(await store.settle(keyOf(orgA), settlement)).toBe(false);

    expect(await store.current(keyOf(orgA))).toBe(before - 18n);
    expect(
      await as<{ organization_id: string; workspace_id: string; quantity: string; period_start: string }>(
        'app_system',
        `SELECT organization_id, workspace_id, quantity::text, period_start::text
           FROM usage_record WHERE source_id = $1`,
        [sourceId],
      ),
    ).toEqual([
      { organization_id: orgA, workspace_id: workspaceA, quantity: '12', period_start: '2026-10-01' },
    ]);
  });

  it('keeps the counter at zero or above and books usage without a workspace', async () => {
    const store = new PrismaQuotaStore(client());
    await store.reserve(keyOf(orgB), 5n, 100n);

    expect(
      await store.settle(keyOf(orgB), {
        workspaceId: null,
        reserved: 50n,
        quantity: 0n,
        sourceType: 'ai_generation',
        sourceId: randomUUID(),
      }),
    ).toBe(true);
    expect(await store.current(keyOf(orgB))).toBe(0n);
  });

  it('reads the prices valid at an instant, including later ones from a migration', async () => {
    const catalog = new PrismaPriceCatalog(client(), 0);
    const october2026 = await catalog.pricesAt(october.now());

    expect([...october2026.keys()].sort()).toEqual(['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5']);
    expect(october2026.get('claude-opus-5-5')).toEqual({
      inputMicrosPerMtok: 4_000_000n,
      outputMicrosPerMtok: 20_000_000n,
      cacheReadMicrosPerMtok: 200_000n,
      cacheWrite5mMicrosPerMtok: 5_000_000n,
      cacheWrite1hMicrosPerMtok: 8_000_000n,
    });
    expect((await catalog.pricesAt(new Date('2026-01-01T00:00:00Z'))).size).toBe(0);

    // A later price, as a future migration would add it.
    await as(
      'app_migrator',
      `INSERT INTO price_book (id, model, valid_from, input_micros_per_mtok, output_micros_per_mtok,
                               cache_read_micros_per_mtok, cache_write_5m_micros_per_mtok,
                               cache_write_1h_micros_per_mtok, source, checked_at)
       VALUES (gen_random_uuid(), 'claude-opus-5-5', '2027-01-01T00:00:00Z', 3000000, 15000000, 150000,
               3750000, 6000000, 'test', '2026-10-16')`,
    );
    expect((await catalog.pricesAt(october.now())).get('claude-opus-5-5')?.inputMicrosPerMtok).toBe(
      4_000_000n,
    );
    expect(
      (await catalog.pricesAt(new Date('2027-02-01T00:00:00Z'))).get('claude-opus-5-5')?.inputMicrosPerMtok,
    ).toBe(3_000_000n);

    const costs = new CostCalculator({ prices: catalog, clock: october });
    expect(await costs.estimateMicros('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      4_000_000n,
    );
  });
});
