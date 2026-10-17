import { randomUUID } from 'node:crypto';

import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ChannelReadModel,
  createPrismaClient,
  InvalidCursorError,
  VariantListReadModel,
  type PrismaClient,
  type VariantListFilter,
} from '../src';

// Guide step 4.11 on PostgreSQL: the variants of a workspace for the calendar (a period in the
// order of the plan), the dashboard and the post list (last changed first, with filters), paged
// by cursor and invisible to another workspace; the accounts page shows what the paid calls of
// an X account cost so far.

const orgA = randomUUID();
const orgB = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const refA = { organizationId: orgA, workspaceId: workspaceA };
const xConnection = randomUUID();
const linkedinConnection = randomUUID();
const xAccount = randomUUID();
const linkedinAccount = randomUUID();
const postId = randomUUID();

/** The variants of the post in workspace A, by key. */
const variants = {
  draft: { id: randomUUID(), platform: 'X', account: xAccount, status: 'DRAFT', at: null },
  early: {
    id: randomUUID(),
    platform: 'LINKEDIN',
    account: linkedinAccount,
    status: 'SCHEDULED',
    at: '2026-10-20T08:00:00Z',
  },
  late: {
    id: randomUUID(),
    platform: 'X',
    account: xAccount,
    status: 'SCHEDULED',
    at: '2026-10-22T08:00:00Z',
  },
  queued: {
    id: randomUUID(),
    platform: 'X',
    account: xAccount,
    status: 'QUEUED',
    at: '2026-10-21T08:00:00Z',
  },
  published: {
    id: randomUUID(),
    platform: 'LINKEDIN',
    account: linkedinAccount,
    status: 'PUBLISHED',
    at: '2026-10-10T08:00:00Z',
  },
  deleted: {
    id: randomUUID(),
    platform: 'X',
    account: xAccount,
    status: 'DELETED',
    at: '2026-10-21T09:00:00Z',
  },
} as const;

describe('variant list on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;

  const ready = () => {
    if (!database || !base) {
      throw new Error('database not ready');
    }
    return { database, base };
  };
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
  const list = (filter: Partial<VariantListFilter>, ref = refA) =>
    new VariantListReadModel(ready().base).list(ref, { order: 'recent', limit: 50, ...filter });
  const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`, [
      orgA,
      orgB,
    ]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'variants-a', 'A', 'Europe/Berlin', 'de', now()),
              ($3, $4, 'variants-b', 'B', 'Europe/Berlin', 'de', now())`,
      [workspaceA, orgA, workspaceB, orgB],
    );
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, status, external_user_id, display_name,
                                      access_token_sealed, updated_at)
       VALUES ($1, $3, 'X', 'MOCK', 'ACTIVE', 'mira', 'Mira', '\\x01', now()),
              ($2, $3, 'LINKEDIN', 'MOCK', 'ACTIVE', 'mira', 'Mira', '\\x01', now())`,
      [xConnection, linkedinConnection, workspaceA],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, handle,
                                   updated_at)
       VALUES ($1, $3, $4, 'X', 'PROFILE', 'x-mira', 'Mira on X', 'mira', now()),
              ($2, $3, $5, 'LINKEDIN', 'PROFILE', 'urn:li:person:mira', 'Mira Becker', NULL, now())`,
      [xAccount, linkedinAccount, workspaceA, xConnection, linkedinConnection],
    );
    await query(`INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`, [
      postId,
      workspaceA,
    ]);
    // Changed one after another: the draft first, the deleted one last.
    for (const [index, [key, variant]] of Object.entries(variants).entries()) {
      await query(
        `INSERT INTO post_variant (id, workspace_id, post_id, social_account_id, platform, target_key, text, status,
                                   scheduled_at, scheduled_timezone, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          variant.id,
          workspaceA,
          postId,
          variant.account,
          variant.platform,
          key,
          key === 'draft' ? `Ein Entwurf\nmit   zwei Zeilen und ${'langem Text '.repeat(20)}` : `Text ${key}`,
          variant.status,
          variant.at,
          variant.at ? 'Europe/Berlin' : null,
          new Date(Date.UTC(2026, 9, 16, 12, index)),
        ],
      );
    }
    base = createPrismaClient(database.url('app_user'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await database?.stop();
  });

  it('lists a period of the plan in its order, without drafts and deleted variants', async () => {
    const page = await list({ order: 'schedule', from: new Date('2026-10-20T00:00:00Z') });
    expect(ids(page)).toEqual([variants.early.id, variants.queued.id, variants.late.id]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toEqual({
      id: variants.early.id,
      postId,
      platform: 'LINKEDIN',
      status: 'SCHEDULED',
      version: 0,
      preview: 'Text early',
      account: { id: linkedinAccount, name: 'Mira Becker', handle: null, type: 'PROFILE' },
      scheduledAt: new Date('2026-10-20T08:00:00Z'),
      scheduledTimezone: 'Europe/Berlin',
      publishedAt: null,
      externalUrl: null,
      failureCode: null,
      isDryRun: false,
      updatedAt: new Date('2026-10-16T12:01:00Z'),
    });

    // The end of the period is exclusive.
    const week = await list({
      order: 'schedule',
      from: new Date('2026-10-20T08:00:00Z'),
      to: new Date('2026-10-22T08:00:00Z'),
    });
    expect(ids(week)).toEqual([variants.early.id, variants.queued.id]);
  });

  it('lists the last changed first and filters by status, platform and account', async () => {
    expect(ids(await list({}))).toEqual([
      variants.published.id,
      variants.queued.id,
      variants.late.id,
      variants.early.id,
      variants.draft.id,
    ]);
    expect(ids(await list({ statuses: ['SCHEDULED', 'QUEUED'], platform: 'X' }))).toEqual([
      variants.queued.id,
      variants.late.id,
    ]);
    expect(ids(await list({ accountId: linkedinAccount }))).toEqual([
      variants.published.id,
      variants.early.id,
    ]);
    // Asked for, a deleted variant is listed as well.
    expect(ids(await list({ statuses: ['DELETED'] }))).toEqual([variants.deleted.id]);

    const [draft] = (await list({ statuses: ['DRAFT'] })).items;
    expect(draft?.preview).toHaveLength(140);
    expect(draft?.preview).toMatch(/^Ein Entwurf mit zwei Zeilen und langem Text .*\.\.\.$/);
  });

  it('pages by cursor in both orders', async () => {
    const first = await list({ limit: 2 });
    expect(ids(first)).toEqual([variants.published.id, variants.queued.id]);
    const second = await list({ limit: 2, cursor: first.nextCursor ?? '' });
    expect(ids(second)).toEqual([variants.late.id, variants.early.id]);
    const third = await list({ limit: 2, cursor: second.nextCursor ?? '' });
    expect(ids(third)).toEqual([variants.draft.id]);
    expect(third.nextCursor).toBeNull();

    const planned = await list({ order: 'schedule', limit: 3 });
    expect(ids(planned)).toEqual([variants.published.id, variants.early.id, variants.queued.id]);
    const rest = await list({ order: 'schedule', limit: 3, cursor: planned.nextCursor ?? '' });
    expect(ids(rest)).toEqual([variants.late.id]);

    expect(() => list({ cursor: 'not-a-cursor' })).toThrow(InvalidCursorError);
  });

  it('shows the variants of a workspace to that workspace only', async () => {
    await expect(list({}, { organizationId: orgB, workspaceId: workspaceB })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('adds up the paid calls of an X account; other platforms cost nothing', async () => {
    const accounts = () => new ChannelReadModel(ready().base).accounts(refA);
    expect((await accounts()).map(({ platform, costMicros }) => ({ platform, costMicros }))).toEqual([
      { platform: 'LINKEDIN', costMicros: null },
      { platform: 'X', costMicros: 0 },
    ]);

    await query(
      `INSERT INTO api_cost_record (id, organization_id, workspace_id, social_account_id, platform, operation,
                                    cost_micros, source_type, source_id)
       VALUES ($1, $3, $4, $5, 'X', 'x.post_create', 10000, 'publish_attempt', $6),
              ($2, $3, $4, $5, 'X', 'x.media_upload', 2500, 'publish_attempt', $6)`,
      [randomUUID(), randomUUID(), orgA, workspaceA, xAccount, randomUUID()],
    );
    expect((await accounts()).find((account) => account.platform === 'X')?.costMicros).toBe(12_500);
  });
});
