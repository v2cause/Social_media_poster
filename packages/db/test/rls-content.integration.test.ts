import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import { findRlsViolations } from '../src';
import { ids, inContext } from './support/sql-context';

// Guide step 2.1: the content and AI tables are isolated per workspace or organization, the
// snapshots and ledgers are append-only for app_user, and the reference data is read-only.

const PRESET_KEYS = [
  'professional',
  'storytelling',
  'casual',
  'educational',
  'thought_leadership',
  'promotional',
];

// Organization A with workspace a1, organization B with workspace b1; one row of every content
// table in each workspace.
const f = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  a1: randomUUID(),
  b1: randomUUID(),
  styleA: randomUUID(),
  styleB: randomUUID(),
  voiceA: randomUUID(),
  voiceB: randomUUID(),
  versionA: randomUUID(),
  versionB: randomUUID(),
  ideaA: randomUUID(),
  ideaB: randomUUID(),
  postA: randomUUID(),
  postB: randomUUID(),
  variantA: randomUUID(),
  variantB: randomUUID(),
  generationA: randomUUID(),
  generationB: randomUUID(),
  counterA: randomUUID(),
  counterB: randomUUID(),
  recordA: randomUUID(),
  recordB: randomUUID(),
};

const CONTENT_TABLES = [
  'brand_voice',
  'idea',
  'post',
  'post_variant',
  'brand_voice_version',
  'ai_generation',
];

describe('row-level security of the content and AI tables', () => {
  let database: TestDatabase | undefined;
  let runtime: Client | undefined;

  const db = (): TestDatabase => {
    if (!database) {
      throw new Error('PostgreSQL test container is not running');
    }
    return database;
  };
  const app = (): Client => {
    if (!runtime) {
      throw new Error('app_user is not connected');
    }
    return runtime;
  };
  const inA = <T>(fn: () => Promise<T>): Promise<T> =>
    inContext(app(), { organizationId: f.orgA, workspaceId: f.a1 }, fn);

  beforeAll(async () => {
    database = await startTestDatabase();
    const system = await database.connectAs('app_system');
    try {
      await system.query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`,
        [f.orgA, f.orgB],
      );
      await system.query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $2, 'content-a1', 'A1', 'Europe/Berlin', 'de', now()),
                ($3, $4, 'content-b1', 'B1', 'Europe/Berlin', 'en', now())`,
        [f.a1, f.orgA, f.b1, f.orgB],
      );
      for (const [ws, style, voice, version, idea, post, variant, generation] of [
        [f.a1, f.styleA, f.voiceA, f.versionA, f.ideaA, f.postA, f.variantA, f.generationA],
        [f.b1, f.styleB, f.voiceB, f.versionB, f.ideaB, f.postB, f.variantB, f.generationB],
      ] as const) {
        await system.query(
          `INSERT INTO post_style (id, workspace_id, key, name, instructions, updated_at)
           VALUES ($1, $2, 'custom-house', 'House style', 'Short and warm.', now())`,
          [style, ws],
        );
        await system.query(
          `INSERT INTO brand_voice (id, workspace_id, name, current_version_number, updated_at)
           VALUES ($1, $2, 'Voice', 1, now())`,
          [voice, ws],
        );
        await system.query(
          `INSERT INTO brand_voice_version (id, workspace_id, brand_voice_id, version_number, content, content_hash)
           VALUES ($1, $2, $3, 1, '{}', 'hash')`,
          [version, ws, voice],
        );
        await system.query(
          `INSERT INTO idea (id, workspace_id, title, updated_at) VALUES ($1, $2, 'An idea', now())`,
          [idea, ws],
        );
        await system.query(
          `INSERT INTO post (id, workspace_id, language, style_id, brand_voice_id, idea_id, updated_at)
           VALUES ($1, $2, 'de', $3, $4, $5, now())`,
          [post, ws, style, voice, idea],
        );
        await system.query(
          `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, updated_at)
           VALUES ($1, $2, $3, 'LINKEDIN', 't1', now())`,
          [variant, ws, post],
        );
        await system.query(
          `INSERT INTO ai_generation (id, workspace_id, task, post_id, brand_voice_version_id, prompt_version,
                                      provider, model_requested, effort, input, outcome)
           VALUES ($1, $2, 'GENERATE', $3, $4, 'gen-v1', 'mock', 'claude-opus-5-5', 'medium', '{}', 'OK')`,
          [generation, ws, post, version],
        );
      }
      await system.query(
        `INSERT INTO usage_counter (id, organization_id, meter, period_start, value, updated_at)
         VALUES ($1, $2, 'ai_micros', '2026-10-01', 100, now()), ($3, $4, 'ai_micros', '2026-10-01', 200, now())`,
        [f.counterA, f.orgA, f.counterB, f.orgB],
      );
      await system.query(
        `INSERT INTO usage_record (id, organization_id, workspace_id, meter, source_type, source_id, quantity, period_start)
         VALUES ($1, $2, $3, 'ai_micros', 'ai_generation', $4, 100, '2026-10-01'),
                ($5, $6, $7, 'ai_micros', 'ai_generation', $8, 200, '2026-10-01')`,
        [f.recordA, f.orgA, f.a1, f.generationA, f.recordB, f.orgB, f.b1, f.generationB],
      );
    } finally {
      await system.end();
    }
    runtime = await database.connectAs('app_user');
  }, 300_000);

  afterAll(async () => {
    await runtime?.end();
    await database?.stop();
  });

  it('passes the RLS check with the new tables', async () => {
    const owner = await db().connectAs('app_migrator');
    try {
      await expect(findRlsViolations(owner)).resolves.toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it('ships the style presets and the prices of the default model and its fallback targets', async () => {
    const presets = await inContext(app(), {}, async () => {
      const { rows } = await app().query<{ key: string }>(
        'SELECT key FROM post_style WHERE workspace_id IS NULL ORDER BY sort_order',
      );
      return rows.map((row) => row.key);
    });
    expect(presets).toEqual(PRESET_KEYS);

    const prices = await inContext(app(), {}, async () => {
      const { rows } = await app().query<{
        model: string;
        input: string;
        output: string;
        cache_read: string;
      }>(
        `SELECT model, input_micros_per_mtok AS input, output_micros_per_mtok AS output,
                cache_read_micros_per_mtok AS cache_read
           FROM price_book ORDER BY model`,
      );
      return rows;
    });
    expect(prices).toEqual([
      { model: 'claude-opus-4-8', input: '5000000', output: '25000000', cache_read: '500000' },
      { model: 'claude-opus-5', input: '5000000', output: '25000000', cache_read: '500000' },
      { model: 'claude-opus-5-5', input: '4000000', output: '20000000', cache_read: '200000' },
    ]);
  });

  it('shows every content table of the workspace in context and nothing without it', async () => {
    for (const table of CONTENT_TABLES) {
      const inWorkspace = await inA(() => ids(app(), `SELECT id FROM ${table}`));
      const orgOnly = await inContext(app(), { organizationId: f.orgA }, () =>
        ids(app(), `SELECT id FROM ${table}`),
      );
      expect(inWorkspace, table).toHaveLength(1);
      expect(orgOnly, table).toEqual([]);
    }
    expect(await inA(() => ids(app(), 'SELECT id FROM post'))).toEqual([f.postA]);
    expect(await inA(() => ids(app(), 'SELECT id FROM post_variant'))).toEqual([f.variantA]);
  });

  it('rejects writes into another workspace', async () => {
    await expect(
      inA(() =>
        app().query(
          `INSERT INTO post (id, workspace_id, language, updated_at) VALUES (gen_random_uuid(), $1, 'de', now())`,
          [f.b1],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const moved = await inA(() =>
      app().query('UPDATE post_variant SET text = $1 WHERE id = $2', ['hijacked', f.variantB]),
    );
    expect(moved.rowCount).toBe(0);
    await expect(
      inA(() => app().query('UPDATE post SET workspace_id = $1 WHERE id = $2', [f.b1, f.postA])),
    ).rejects.toThrow(/row-level security/);
  });

  it('shows the presets everywhere and custom styles only in their workspace', async () => {
    const inWorkspaceA = await inA(() => ids(app(), 'SELECT id FROM post_style'));
    expect(inWorkspaceA).toHaveLength(PRESET_KEYS.length + 1);
    expect(inWorkspaceA).toContain(f.styleA);
    expect(inWorkspaceA).not.toContain(f.styleB);
  });

  it('lets app_user change custom styles of the workspace but never a preset', async () => {
    const custom = await inA(() =>
      app().query(`UPDATE post_style SET name = 'Renamed' WHERE id = $1`, [f.styleA]),
    );
    expect(custom.rowCount).toBe(1);

    const presets = await inA(() =>
      app().query(`UPDATE post_style SET instructions = 'changed' WHERE workspace_id IS NULL`),
    );
    expect(presets.rowCount).toBe(0);
    const deleted = await inA(() => app().query('DELETE FROM post_style WHERE workspace_id IS NULL'));
    expect(deleted.rowCount).toBe(0);
    await expect(
      inA(() =>
        app().query(
          `INSERT INTO post_style (id, workspace_id, key, name, instructions, updated_at)
           VALUES (gen_random_uuid(), NULL, 'sneaky', 'Sneaky', 'x', now())`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('keeps brand voice versions, AI generations and the usage ledger append-only', async () => {
    const statements: [string, string][] = [
      ['brand_voice_version', "UPDATE brand_voice_version SET content_hash = 'x'"],
      ['brand_voice_version', 'DELETE FROM brand_voice_version'],
      ['ai_generation', "UPDATE ai_generation SET outcome = 'REFUSED'"],
      ['ai_generation', 'DELETE FROM ai_generation'],
      ['usage_record', 'UPDATE usage_record SET quantity = 0'],
      ['usage_record', 'DELETE FROM usage_record'],
      ['usage_counter', 'DELETE FROM usage_counter'],
    ];
    for (const [table, statement] of statements) {
      await expect(
        inA(() => app().query(statement)),
        statement,
      ).rejects.toThrow(new RegExp(`permission denied for table ${table}`));
    }

    const version = await inA(() =>
      app().query(
        `INSERT INTO brand_voice_version (id, workspace_id, brand_voice_id, version_number, content, content_hash)
         VALUES (gen_random_uuid(), $1, $2, 2, '{}', 'hash2')`,
        [f.a1, f.voiceA],
      ),
    );
    expect(version.rowCount).toBe(1);
  });

  it('isolates usage counters and records by organization', async () => {
    const counters = await inContext(app(), { organizationId: f.orgA }, () =>
      ids(app(), 'SELECT id FROM usage_counter'),
    );
    const records = await inContext(app(), { organizationId: f.orgA }, () =>
      ids(app(), 'SELECT id FROM usage_record'),
    );
    expect(counters).toEqual([f.counterA]);
    expect(records).toEqual([f.recordA]);

    const raised = await inContext(app(), { organizationId: f.orgA }, () =>
      app().query('UPDATE usage_counter SET value = value + 1 RETURNING id'),
    );
    expect(raised.rows).toEqual([{ id: f.counterA }]);
  });

  it('keeps the price book read-only at runtime', async () => {
    for (const role of ['app_user', 'app_system'] as const) {
      const client = await db().connectAs(role);
      try {
        await expect(client.query('UPDATE price_book SET input_micros_per_mtok = 0')).rejects.toThrow(
          /permission denied for table price_book/,
        );
        await expect(client.query('DELETE FROM price_book')).rejects.toThrow(
          /permission denied for table price_book/,
        );
      } finally {
        await client.end();
      }
    }
  });
});
