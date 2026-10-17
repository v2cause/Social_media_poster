import { randomUUID } from 'node:crypto';

import { formatLocalTime } from '@smp/core';
import type { PlanResultDto, PostDto, VariantDto, VariantPageDto } from '@smp/contracts';
import { createPrismaClient, DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '@smp/db';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { signIn, type Browser } from './support/browser';

// Guide step 4.6 through the API: plan, move, cancel and post a variant now, with local times
// and their zone, the checks of time, account and content, and the outbox events the worker
// picks up. Guide step 4.11: the list of the variants for the calendar and the post list.

const SEED_PASSWORD = 'seed-password-for-the-publishing-test';
const ws = `/api/w/${DEMO_WORKSPACE_SLUG}`;
const ZONE = 'Europe/Berlin';

const userOf = (role: string) => {
  const user = DEMO_USERS.find((candidate) => candidate.role === role);
  if (!user) {
    throw new Error(`no demo user with role ${role}`);
  }
  return user;
};

/** The local time in Berlin a number of days from now, at 09:30. */
const inDays = (days: number): string =>
  `${formatLocalTime(new Date(Date.now() + days * 86_400_000), ZONE).slice(0, 10)}T09:30`;

describe('publishing API', () => {
  let api: ApiTestApp | undefined;
  let system: Client | undefined;
  let editor: Browser | undefined;
  let viewer: Browser | undefined;
  let workspaceId = '';
  const accountId = randomUUID();

  const as = (browser: Browser | undefined): Browser => {
    if (!browser) {
      throw new Error('not signed in');
    }
    return browser;
  };
  const sql = async <T>(text: string, values: unknown[] = []): Promise<T[]> => {
    if (!system) {
      throw new Error('database not ready');
    }
    return (await system.query(text, values)).rows as T[];
  };

  /** A LinkedIn variant with text, ready to be planned. */
  const draft = async (): Promise<VariantDto> => {
    const post = (
      await as(editor)
        .post(`${ws}/posts`)
        .send({ brief: 'Tag der offenen Tür', language: 'de', platforms: ['LINKEDIN'] })
        .expect(201)
    ).body as PostDto;
    const [variant] = post.variants;
    return (
      await as(editor)
        .patch(`${ws}/variants/${variant?.id ?? ''}`)
        .send({ version: 0, text: 'Am Samstag öffnen wir unsere Werkstatt.' })
        .expect(200)
    ).body as VariantDto;
  };

  beforeAll(async () => {
    api = await startApiTestApp();
    const seed = createPrismaClient(api.database.url('app_system'));
    try {
      await seedDemoData(seed, SEED_PASSWORD);
      workspaceId = (await seed.workspace.findFirstOrThrow({ where: { slug: DEMO_WORKSPACE_SLUG } })).id;
    } finally {
      await seed.$disconnect();
    }
    system = await api.database.connectAs('app_system');
    const connectionId = randomUUID();
    await sql(
      `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                      access_token_sealed, access_token_expires_at, updated_at)
       VALUES ($1, $2, 'LINKEDIN', 'MOCK', 'mock-user', 'Mock', '\\x00', now() + interval '60 days', now())`,
      [connectionId, workspaceId],
    );
    await sql(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', 'PROFILE', 'urn:li:person:mock-user', 'Mock', now())`,
      [accountId, workspaceId, connectionId],
    );
    editor = await signIn(api, userOf('EDITOR').email, SEED_PASSWORD);
    viewer = await signIn(api, userOf('VIEWER').email, SEED_PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await system?.end();
    await api?.close();
  });

  it('plans a variant for a local time and answers with the variant as it is now', async () => {
    const variant = await draft();
    const local = inDays(3);

    const plan = (
      await as(editor)
        .post(`${ws}/variants/${variant.id}/schedule`)
        .send({ version: variant.version, localDateTime: local, timeZone: ZONE, socialAccountId: accountId })
        .expect(200)
    ).body as PlanResultDto;

    expect(plan).toMatchObject({
      status: 'SCHEDULED',
      warnings: [],
      variant: { id: variant.id, status: 'SCHEDULED', socialAccountId: accountId, scheduledTimezone: ZONE },
    });
    expect(formatLocalTime(new Date(plan.variant.scheduledAt ?? ''), ZONE)).toBe(local);
    const [row] = await sql<{ schedule_version: number }>(
      'SELECT schedule_version FROM post_variant WHERE id = $1',
      [variant.id],
    );
    expect(row?.schedule_version).toBe(1);
  });

  it('refuses a time in the past and names the next valid time after a change of the clocks', async () => {
    const variant = await draft();
    const plan = (localDateTime: string) =>
      as(editor)
        .post(`${ws}/variants/${variant.id}/schedule`)
        .send({ version: variant.version, localDateTime, timeZone: ZONE, socialAccountId: accountId });

    expect((await plan(inDays(-1)).expect(422)).body).toMatchObject({ code: 'SCHEDULE_TIME_IN_PAST' });
    expect((await plan('2027-03-28T02:30').expect(422)).body).toMatchObject({
      code: 'SCHEDULE_TIME_IN_GAP',
      params: { suggestion: '2027-03-28T03:00', timeZone: ZONE },
    });
    expect((await plan('2026-02-30T10:00').expect(422)).body).toMatchObject({
      code: 'INVALID_SCHEDULE_TIME',
    });
    expect(
      (
        await as(editor)
          .post(`${ws}/variants/${variant.id}/schedule`)
          .send({ version: variant.version, localDateTime: inDays(2), timeZone: ZONE })
          .expect(422)
      ).body,
    ).toMatchObject({ code: 'SOCIAL_ACCOUNT_REQUIRED' });
  });

  it('moves, cancels and posts a variant now, and locks it while it goes out', async () => {
    const variant = await draft();
    let current = (
      await as(editor)
        .post(`${ws}/variants/${variant.id}/schedule`)
        .send({
          version: variant.version,
          localDateTime: inDays(2),
          timeZone: ZONE,
          socialAccountId: accountId,
        })
        .expect(200)
    ).body as PlanResultDto;

    current = (
      await as(editor)
        .post(`${ws}/variants/${variant.id}/reschedule`)
        .send({ version: current.variant.version, localDateTime: inDays(4), timeZone: ZONE })
        .expect(200)
    ).body as PlanResultDto;
    expect(current.variant.status).toBe('SCHEDULED');
    await as(editor)
      .post(`${ws}/variants/${variant.id}/cancel`)
      .send({ version: variant.version })
      .expect(409);
    current = (
      await as(editor)
        .post(`${ws}/variants/${variant.id}/cancel`)
        .send({ version: current.variant.version })
        .expect(200)
    ).body as PlanResultDto;
    expect(current.status).toBe('CANCELED');

    current = (
      await as(editor)
        .post(`${ws}/variants/${variant.id}/publish-now`)
        .send({ version: current.variant.version, timeZone: ZONE })
        .expect(200)
    ).body as PlanResultDto;
    expect(current.variant.status).toBe('QUEUED');
    const events = await sql<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM outbox_event WHERE payload->>'variantId' = $1 ORDER BY created_at, id`,
      [variant.id],
    );
    expect(events.map((event) => [event.type, event.payload['status'] ?? event.payload['trigger']])).toEqual([
      ['variant.status', 'SCHEDULED'],
      ['variant.status', 'SCHEDULED'],
      ['variant.status', 'CANCELED'],
      ['variant.status', 'QUEUED'],
      ['publish.requested', 'now'],
    ]);

    const locked = await as(editor)
      .patch(`${ws}/variants/${variant.id}`)
      .send({ version: current.variant.version, text: 'Noch schnell ändern' })
      .expect(409);
    expect(locked.body).toMatchObject({ code: 'VARIANT_LOCKED' });
    const audit = await sql<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_id = $1 ORDER BY created_at`,
      [variant.id],
    );
    expect(audit.map((entry) => entry.action)).toEqual([
      'variant.schedule',
      'variant.reschedule',
      'variant.cancel',
      'variant.publish_now',
    ]);
  });

  it('is for editors and above and reports a status that does not allow the step', async () => {
    const variant = await draft();
    await as(viewer)
      .post(`${ws}/variants/${variant.id}/schedule`)
      .send({
        version: variant.version,
        localDateTime: inDays(2),
        timeZone: ZONE,
        socialAccountId: accountId,
      })
      .expect(403);

    const wrong = await as(editor)
      .post(`${ws}/variants/${variant.id}/resolve`)
      .send({ version: variant.version, action: 'recheck' })
      .expect(409);
    expect(wrong.body).toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      params: { from: 'DRAFT', to: 'QUEUED' },
    });
  });

  it('lists the planned variants by time and every variant page by page, also to viewers', async () => {
    const list = (query: Record<string, string | number>) =>
      as(viewer).get(`${ws}/variants`).query(query).expect(200);

    // The variant posted now first, then the one planned in three days.
    const planned = (await list({ order: 'schedule', status: 'SCHEDULED,QUEUED' })).body as VariantPageDto;
    expect(planned.items.map((item) => item.status)).toEqual(['QUEUED', 'SCHEDULED']);
    expect(planned.items[1]).toMatchObject({
      platform: 'LINKEDIN',
      preview: 'Am Samstag öffnen wir unsere Werkstatt.',
      account: { id: accountId, name: 'Mock', handle: null, type: 'PROFILE' },
      scheduledTimezone: ZONE,
      publishedAt: null,
      failureCode: null,
    });
    expect(planned.nextCursor).toBeNull();

    const all = (await list({})).body as VariantPageDto;
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await list({ limit: 2, ...(cursor ? { cursor } : {}) })).body as VariantPageDto;
      paged.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(all.items.map((item) => item.id));
    expect(new Set(paged).size).toBe(4);

    const invalid = (query: Record<string, string>) => as(viewer).get(`${ws}/variants`).query(query);
    expect((await invalid({ status: 'SCHEDULED,LOST' }).expect(400)).body).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await invalid({ from: '2026-11-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }).expect(400);
    expect((await invalid({ cursor: 'forged' }).expect(422)).body).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('plans no more posts in a month than the plan allows (guide step 7.4)', async () => {
    const variant = await draft();
    const [demo] = await sql<{ organization_id: string }>(
      'SELECT organization_id FROM workspace WHERE id = $1',
      [workspaceId],
    );
    const organizationId = demo?.organization_id ?? '';
    // A plan without posts: nothing more goes out this month.
    await sql(
      `UPDATE subscription SET limit_overrides = '{"scheduledPostsPerMonth": 0}' WHERE organization_id = $1`,
      [organizationId],
    );
    try {
      const refused = await as(editor)
        .post(`${ws}/variants/${variant.id}/schedule`)
        .send({
          version: variant.version,
          localDateTime: inDays(3),
          timeZone: ZONE,
          socialAccountId: accountId,
        })
        .expect(402);
      expect(refused.body).toMatchObject({
        code: 'PLAN_LIMIT_REACHED',
        params: { limit: 'scheduledPostsPerMonth', max: 0 },
      });
    } finally {
      await sql(`UPDATE subscription SET limit_overrides = NULL WHERE organization_id = $1`, [
        organizationId,
      ]);
    }
  });
});
