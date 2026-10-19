import { randomUUID } from 'node:crypto';

import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPublishJobPool,
  createSystemPrismaClient,
  markOpenAttemptsAfterRestore,
  PgPublishJobUnitOfWork,
  type PublishJobPool,
  type SystemPrismaClient,
} from '../src';

// Guide step 8.6 on PostgreSQL: after a restore to the time T, every variant the publisher still
// has to send gets one open attempt that started at T, in every workspace, with the next number
// of its schedule version. Variants in other states stay as they are, and so does one with an
// open attempt from before T. A second run adds nothing, and the publish job lists the new
// attempt as unclear, so it reconciles since T before it sends.

const org = randomUUID();
const workspaces = [randomUUID(), randomUUID()] as const;
const RESTORED_TO = new Date('2026-10-19T01:57:53.434Z');
const STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'QUEUED',
  'PUBLISHING',
  'RETRYING',
  'PUBLISHED',
  'FAILED',
  'NEEDS_ATTENTION',
  'CANCELED',
  'DELETED',
] as const;
const PENDING = new Set(['SCHEDULED', 'QUEUED', 'PUBLISHING', 'RETRYING']);

interface AttemptRow {
  variant_id: string;
  schedule_version: number;
  attempt_number: number;
  trigger: string;
  outcome: string;
  lease_owner: string;
  started_at: Date;
}

describe('the open attempts after a restore on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let system: SystemPrismaClient | undefined;
  let pool: PublishJobPool | undefined;
  /** Variant ids by workspace index and status. */
  const variants = new Map<string, string>();
  let earlierOpen = '';
  let laterVersion = '';

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
  const addVariant = async (
    workspaceId: string,
    postId: string,
    status: string,
    scheduleVersion = 1,
  ): Promise<string> => {
    const id = randomUUID();
    await query(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, text, status, schedule_version,
                                 scheduled_at, updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', $7, 'Wir suchen Verstärkung.', $4::"VariantStatus", $5, $6, now())`,
      [id, workspaceId, postId, status, scheduleVersion, RESTORED_TO, `t-${id}`],
    );
    return id;
  };
  const addAttempt = (
    workspaceId: string,
    variantId: string,
    attempt: { scheduleVersion: number; number: number; outcome: string; startedAt: Date },
  ): Promise<unknown[]> =>
    query(
      `INSERT INTO publish_attempt (id, workspace_id, variant_id, schedule_version, attempt_number, trigger,
                                    outcome, lease_owner, started_at)
       VALUES ($1, $2, $3, $4, $5, 'schedule', $6::"PublishAttemptOutcome", 'worker:1', $7)`,
      [
        randomUUID(),
        workspaceId,
        variantId,
        attempt.scheduleVersion,
        attempt.number,
        attempt.outcome,
        attempt.startedAt,
      ],
    );
  const restoreAttempts = (): Promise<AttemptRow[]> =>
    query<AttemptRow>(
      `SELECT variant_id, schedule_version, attempt_number, trigger, outcome::text AS outcome, lease_owner, started_at
         FROM publish_attempt WHERE trigger = 'restore' ORDER BY variant_id`,
    );

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Org', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $3, 'restore-1', 'One', 'Europe/Berlin', 'de', now()),
              ($2, $3, 'restore-2', 'Two', 'Europe/Berlin', 'de', now())`,
      [workspaces[0], workspaces[1], org],
    );
    for (const [index, workspaceId] of workspaces.entries()) {
      const postId = randomUUID();
      await query(
        `INSERT INTO post (id, workspace_id, brief, language, updated_at) VALUES ($1, $2, 'Brief', 'de', now())`,
        [postId, workspaceId],
      );
      for (const status of STATUSES) {
        variants.set(`${String(index)}:${status}`, await addVariant(workspaceId, postId, status));
      }
      if (index === 0) {
        // Its reconcile already looks back to before T.
        earlierOpen = await addVariant(workspaceId, postId, 'SCHEDULED');
        await addAttempt(workspaceId, earlierOpen, {
          scheduleVersion: 1,
          number: 1,
          outcome: 'UNKNOWN',
          startedAt: new Date(RESTORED_TO.getTime() - 60 * 60 * 1000),
        });
        // Rescheduled after two attempts; the open attempt continues the numbers of version 2.
        laterVersion = await addVariant(workspaceId, postId, 'RETRYING', 2);
        await addAttempt(workspaceId, laterVersion, {
          scheduleVersion: 1,
          number: 1,
          outcome: 'FAILED',
          startedAt: new Date(RESTORED_TO.getTime() - 3 * 60 * 60 * 1000),
        });
        for (const number of [1, 2]) {
          await addAttempt(workspaceId, laterVersion, {
            scheduleVersion: 2,
            number,
            outcome: 'RETRY',
            startedAt: new Date(RESTORED_TO.getTime() - (3 - number) * 60 * 60 * 1000),
          });
        }
      }
    }
    system = createSystemPrismaClient(database.url('app_system'));
    pool = createPublishJobPool(database.url('app_user'), { max: 1, onError: () => undefined });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await system?.$disconnect();
    await database?.stop();
  });

  it('opens one attempt at T for every pending variant, in every workspace', async () => {
    if (!system) {
      throw new Error('database not ready');
    }
    // Four pending states in two workspaces, and the rescheduled variant.
    await expect(markOpenAttemptsAfterRestore(system, RESTORED_TO)).resolves.toEqual({
      marked: 9,
      alreadyOpen: 1,
    });

    const attempts = await restoreAttempts();
    const expected = [...variants.entries()]
      .filter(([key]) => PENDING.has(key.split(':')[1] ?? ''))
      .map(([, id]) => ({
        variant_id: id,
        schedule_version: 1,
        attempt_number: 1,
        trigger: 'restore',
        outcome: 'STARTED',
        lease_owner: 'restore',
        started_at: RESTORED_TO,
      }));
    expected.push({
      variant_id: laterVersion,
      schedule_version: 2,
      attempt_number: 3,
      trigger: 'restore',
      outcome: 'STARTED',
      lease_owner: 'restore',
      started_at: RESTORED_TO,
    });
    expect(attempts).toEqual(expected.sort((a, b) => (a.variant_id < b.variant_id ? -1 : 1)));
    expect(attempts.map((row) => row.variant_id)).not.toContain(earlierOpen);
  });

  it('adds nothing when it runs again', async () => {
    if (!system) {
      throw new Error('database not ready');
    }
    await expect(markOpenAttemptsAfterRestore(system, RESTORED_TO)).resolves.toEqual({
      marked: 0,
      alreadyOpen: 10,
    });
    expect(await restoreAttempts()).toHaveLength(9);
  });

  it('gives the publish job an unclear attempt that started at T', async () => {
    if (!pool) {
      throw new Error('database not ready');
    }
    const variantId = variants.get('1:QUEUED') ?? '';
    const unclear = await new PgPublishJobUnitOfWork(pool).run(
      { organizationId: org, workspaceId: workspaces[1] },
      (store) => store.attempts.unclear(workspaces[1], variantId),
    );
    expect(unclear).toEqual([{ scheduleVersion: 1, outcome: 'STARTED', startedAt: RESTORED_TO }]);
  });
});
