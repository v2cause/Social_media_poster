import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import {
  createSystemPrismaClient,
  PrismaOutboxRelay,
  type PendingOutboxEvent,
  type SystemPrismaClient,
} from '../src';

// Guide step 4.3: the relay claims pending events with SKIP LOCKED and marks them only after a
// successful dispatch, so two relays running at once hand on every event exactly once, and an
// event whose dispatch failed stays pending for a later try.

const org = randomUUID();
const workspaces = [randomUUID(), randomUUID()] as const;
const EVENTS = 200;

describe('PrismaOutboxRelay', () => {
  let database: TestDatabase | undefined;
  const clients: SystemPrismaClient[] = [];

  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    if (!database) {
      throw new Error('database missing');
    }
    const client = await database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const relay = (index: number, batchSize = 20): PrismaOutboxRelay => {
    const client = clients[index];
    if (!client) {
      throw new Error('client missing');
    }
    return new PrismaOutboxRelay(client, { batchSize });
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Org', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $3, 'outbox-1', 'One', 'Europe/Berlin', 'de', now()),
              ($2, $3, 'outbox-2', 'Two', 'Europe/Berlin', 'de', now())`,
      [workspaces[0], workspaces[1], org],
    );
    await query(
      `INSERT INTO outbox_event (id, workspace_id, type, payload)
       SELECT gen_random_uuid(),
              CASE WHEN n % 2 = 0 THEN $1::uuid ELSE $2::uuid END,
              'publish.requested',
              jsonb_build_object('variantId', gen_random_uuid(), 'scheduleVersion', 1, 'trigger', 'now')
         FROM generate_series(1, $3::int) AS n`,
      [workspaces[0], workspaces[1], EVENTS],
    );
    clients.push(
      createSystemPrismaClient(database.url('app_system')),
      createSystemPrismaClient(database.url('app_system')),
    );
  }, 300_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
    await database?.stop();
  });

  it('hands every event on exactly once while two relays run at the same time', async () => {
    const dispatched: PendingOutboxEvent[] = [];
    const collect = async (event: PendingOutboxEvent): Promise<void> => {
      // Keeps the transaction open a moment, so the other relay claims at the same time.
      await sleep(2);
      dispatched.push(event);
    };
    const drain = async (index: number): Promise<number> => {
      let total = 0;
      for (;;) {
        const { relayed } = await relay(index).relay(collect);
        total += relayed;
        if (relayed === 0) {
          return total;
        }
      }
    };

    const [first, second] = await Promise.all([drain(0), drain(1)]);

    expect(first + second).toBe(EVENTS);
    // Both took part, and none of the events came twice.
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(new Set(dispatched.map((event) => event.id)).size).toBe(EVENTS);
    expect(dispatched[0]).toMatchObject({ organizationId: org, type: 'publish.requested', attempts: 0 });
    const [pending] = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM outbox_event WHERE processed_at IS NULL',
    );
    expect(pending?.count).toBe(0);
  });

  it('keeps an event pending when its dispatch fails and tries it again after a pause', async () => {
    const [event] = await query<{ id: string }>(
      `INSERT INTO outbox_event (id, workspace_id, type, payload)
       VALUES (gen_random_uuid(), $1, 'publish.requested', '{}') RETURNING id`,
      [workspaces[0]],
    );

    const report = await relay(0).relay(() => Promise.reject(new Error('Redis is not reachable')));
    expect(report).toEqual({ relayed: 0, failed: 1 });
    const [row] = await query<{
      attempts: number;
      last_error: string;
      waits: boolean;
      processed_at: Date | null;
    }>(
      `SELECT attempts, last_error, available_at > now() AS waits, processed_at FROM outbox_event WHERE id = $1`,
      [event?.id],
    );
    expect(row).toEqual({
      attempts: 1,
      last_error: 'Error: Redis is not reachable',
      waits: true,
      processed_at: null,
    });
    // Not picked up again before its pause is over.
    await expect(relay(1).relay(() => Promise.resolve())).resolves.toEqual({ relayed: 0, failed: 0 });

    await query(`UPDATE outbox_event SET available_at = now() WHERE id = $1`, [event?.id]);
    const seen: PendingOutboxEvent[] = [];
    await relay(1).relay((pending) => {
      seen.push(pending);
      return Promise.resolve();
    });
    expect(seen.map((pending) => [pending.id, pending.attempts])).toEqual([[event?.id, 1]]);
  });

  it('purges processed events after their retention', async () => {
    await query(
      `UPDATE outbox_event SET processed_at = now() - interval '10 days' WHERE processed_at IS NOT NULL`,
    );
    const [total] = await query<{ count: number }>('SELECT count(*)::int AS count FROM outbox_event');

    await expect(relay(0).purgeProcessed(7)).resolves.toBe(total?.count);
    await expect(relay(0).purgeProcessed(7)).resolves.toBe(0);
  });
});
