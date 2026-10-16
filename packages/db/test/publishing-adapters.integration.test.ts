import { randomUUID } from 'node:crypto';

import {
  PublishNow,
  RescheduleVariant,
  ScheduleVariant,
  SocialAccountNotReadyError,
  VariantNotFoundError,
  VersionConflictError,
  type ContentActor,
  type PublishingDependencies,
} from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ContentReadModel,
  createPrismaClient,
  createSystemPrismaClient,
  PrismaOutboxRelay,
  PrismaPublishingUnitOfWork,
  type PendingOutboxEvent,
  type PrismaClient,
  type SystemPrismaClient,
} from '../src';

// Guide step 4.6 on PostgreSQL: the planning use cases of the core store status, schedule
// version, outbox events and audit entry in one transaction under row-level security; two plans
// on the same version do not both win.

const orgA = randomUUID();
const orgB = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const connectionId = randomUUID();
const accountId = randomUUID();
const postId = randomUUID();
const variantId = randomUUID();

const editor: ContentActor = {
  userId: randomUUID(),
  organizationId: orgA,
  workspaceId: workspaceA,
  role: 'EDITOR',
};
const outsider: ContentActor = { ...editor, organizationId: orgB, workspaceId: workspaceB };
const at = (localDateTime: string) => ({ localDateTime, timeZone: 'Europe/Berlin' });

describe('publishing adapters on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;
  let system: SystemPrismaClient | undefined;

  const deps = (): PublishingDependencies => {
    if (!base) {
      throw new Error('database not ready');
    }
    return {
      unitOfWork: new PrismaPublishingUnitOfWork(base, () => ({
        ipAddress: '192.0.2.7',
        userAgent: 'vitest',
      })),
      clock: { now: () => new Date('2026-10-16T12:00:00Z') },
    };
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
  const version = async (): Promise<number> =>
    (await query<{ version: number }>('SELECT version FROM post_variant WHERE id = $1', [variantId]))[0]
      ?.version ?? -1;

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`, [
      orgA,
      orgB,
    ]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'plan-a', 'A', 'Europe/Berlin', 'de', now()),
              ($3, $4, 'plan-b', 'B', 'Europe/Berlin', 'de', now())`,
      [workspaceA, orgA, workspaceB, orgB],
    );
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                      access_token_sealed, access_token_expires_at, updated_at)
       VALUES ($1, $2, 'LINKEDIN', 'MOCK', 'mira', 'Mira', '\\x00', '2026-12-15T12:00:00Z', now())`,
      [connectionId, workspaceA],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', 'PROFILE', 'urn:li:person:mira', 'Mira', now())`,
      [accountId, workspaceA, connectionId],
    );
    await query(
      `INSERT INTO post (id, workspace_id, brief, language, updated_at) VALUES ($1, $2, 'Brief', 'de', now())`,
      [postId, workspaceA],
    );
    await query(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, text, social_account_id, updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', 't1', 'Wir suchen Verstärkung.', $4, now())`,
      [variantId, workspaceA, postId, accountId],
    );
    base = createPrismaClient(database.url('app_user'));
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await system?.$disconnect();
    await database?.stop();
  });

  it('plans a variant with schedule version, outbox event and audit entry in one go', async () => {
    const result = await new ScheduleVariant(deps()).execute({
      actor: editor,
      variantId,
      version: 0,
      at: at('2026-10-20T09:30'),
    });

    expect(result).toEqual({
      status: 'SCHEDULED',
      scheduleVersion: 1,
      scheduledAt: new Date('2026-10-20T07:30:00Z'),
      warnings: [],
    });
    const [row] = await query<Record<string, unknown>>(
      `SELECT status, version, schedule_version, scheduled_at, scheduled_timezone FROM post_variant WHERE id = $1`,
      [variantId],
    );
    expect(row).toEqual({
      status: 'SCHEDULED',
      version: 1,
      schedule_version: 1,
      scheduled_at: new Date('2026-10-20T07:30:00Z'),
      scheduled_timezone: 'Europe/Berlin',
    });
    const [audit] = await query<{ action: string; ip_address: string }>(
      `SELECT action, ip_address FROM audit_log WHERE target_id = $1`,
      [variantId],
    );
    expect(audit).toEqual({ action: 'variant.schedule', ip_address: '192.0.2.7' });
    const view = await new ContentReadModel(base as PrismaClient).variant(
      { organizationId: orgA, workspaceId: workspaceA },
      variantId,
    );
    expect(view).toMatchObject({ scheduledAt: new Date('2026-10-20T07:30:00Z'), socialAccountId: accountId });
  });

  it('lets only one of two plans on the same version win', async () => {
    const current = await version();
    const outcomes = await Promise.allSettled(
      ['2026-10-21T08:00', '2026-10-22T08:00'].map((local) =>
        new RescheduleVariant(deps()).execute({ actor: editor, variantId, version: current, at: at(local) }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const [lost] = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(lost?.reason).toBeInstanceOf(VersionConflictError);
    expect(await version()).toBe(current + 1);
  });

  it('queues at once with a publish request the relay picks up', async () => {
    const result = await new PublishNow(deps()).execute({
      actor: editor,
      variantId,
      version: await version(),
      timeZone: 'Europe/Berlin',
    });

    const relayed: PendingOutboxEvent[] = [];
    await new PrismaOutboxRelay(system as SystemPrismaClient).relay((event) => {
      relayed.push(event);
      return Promise.resolve();
    });
    expect(relayed.map((event) => [event.type, event.payload])).toEqual([
      ['variant.status', { variantId, postId, status: 'SCHEDULED', scheduleVersion: 1 }],
      ['variant.status', { variantId, postId, status: 'SCHEDULED', scheduleVersion: 2 }],
      ['variant.status', { variantId, postId, status: 'QUEUED', scheduleVersion: result.scheduleVersion }],
      ['publish.requested', { variantId, scheduleVersion: result.scheduleVersion, trigger: 'now' }],
    ]);
    expect(relayed.every((event) => event.workspaceId === workspaceA && event.organizationId === orgA)).toBe(
      true,
    );
  });

  it('sees no variant of another workspace and refuses an account that needs a new grant', async () => {
    await expect(
      new ScheduleVariant(deps()).execute({
        actor: outsider,
        variantId,
        version: 0,
        at: at('2026-10-20T09:30'),
      }),
    ).rejects.toBeInstanceOf(VariantNotFoundError);

    await query(`UPDATE post_variant SET status = 'DRAFT' WHERE id = $1`, [variantId]);
    await query(`UPDATE social_connection SET status = 'NEEDS_REAUTH' WHERE id = $1`, [connectionId]);
    await expect(
      new ScheduleVariant(deps()).execute({
        actor: editor,
        variantId,
        version: await version(),
        at: at('2026-10-20T09:30'),
      }),
    ).rejects.toBeInstanceOf(SocialAccountNotReadyError);
  });
});
