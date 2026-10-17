import 'reflect-metadata';

import { randomBytes, randomUUID } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SCHEDULER_QUEUE } from '@smp/queue';
import { startRedis, startTestDatabase, type StartedRedis, type TestDatabase } from '@smp/testing';
import { parseXbCommand, XB_COMMANDS_QUEUE, type XbCommand } from '@smp/x-browser';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TickHandlers } from '../src/processors/scheduler.processor';
import { parseRoles } from '../src/roles';
import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';
import { TICK_HANDLERS } from '../src/worker.tokens';

// Guide step 6.5 through the role "scheduler": with XB_CANARY_ACCOUNT_ID the daily tick of the
// canary gets its job scheduler and sends one command with the session of the test account to
// xb-commands; without the account the scheduler goes again. The browser worker is a stand-in.

const SESSION = Buffer.from('sealed-session-of-the-canary');

describe('the canary of the X browser in the role "scheduler"', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let browserWorker: Worker | undefined;
  const opened: INestApplicationContext[] = [];
  const commands: XbCommand<'canary'>[] = [];

  const started = () => {
    if (!database || !redis) {
      throw new Error('not started');
    }
    return { database, redis };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const scheduler = async (canaryAccountId?: string): Promise<INestApplicationContext> => {
    const key = (): string => `kek-test:${randomBytes(32).toString('base64')}`;
    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ROLES: 'scheduler',
      WORKER_HEALTH_PORT: '0',
      REDIS_URL: started().redis.url,
      DATABASE_URL: started().database.url('app_user'),
      DATABASE_SYSTEM_URL: started().database.url('app_system'),
      TOKEN_KEKS: key(),
      TOKEN_KEK_ACTIVE: 'kek-test',
      SESSION_KEKS: key(),
      SESSION_KEK_ACTIVE: 'kek-test',
      FEATURE_X_BROWSER_GLOBAL: 'true',
      ...(canaryAccountId ? { XB_CANARY_ACCOUNT_ID: canaryAccountId } : {}),
    });
    const context = await NestFactory.createApplicationContext(
      WorkerModule.forRoles(parseRoles(env.WORKER_ROLES), env),
      { logger: false },
    );
    opened.push(context);
    return context;
  };
  const schedulerKeys = async (): Promise<string[]> => {
    const queue = new Queue(SCHEDULER_QUEUE, { connection: { url: started().redis.url } });
    try {
      return (await queue.getJobSchedulers()).map((entry) => entry.key).sort();
    } finally {
      await queue.close();
    }
  };

  beforeAll(async () => {
    [database, redis] = await Promise.all([startTestDatabase(), startRedis()]);
    browserWorker = new Worker(
      XB_COMMANDS_QUEUE,
      (job) => {
        commands.push(parseXbCommand('canary', job.data));
        return Promise.resolve({ ok: true, data: { missing: [] } });
      },
      { connection: { url: redis.url, maxRetriesPerRequest: null } },
    );
  });

  afterAll(async () => {
    for (const context of opened) {
      await context.close();
    }
    await browserWorker?.close();
    await Promise.all([database?.stop(), redis?.stop()]);
  });

  it('runs daily with the session of the test account, and only while it is configured', async () => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const connectionId = randomUUID();
    const accountId = randomUUID();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Platform', now())`, [
      organizationId,
    ]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'canary', 'Canary', 'Europe/Berlin', 'de', now())`,
      [workspaceId, organizationId],
    );
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                      session_sealed, updated_at)
       VALUES ($1, $2, 'X', 'BROWSER', '1846000000000000777', 'Canary', $3, now())`,
      [connectionId, workspaceId, SESSION],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, handle,
                                   settings, updated_at)
       VALUES ($1, $2, $3, 'X', 'PROFILE', '1846000000000000777', 'Canary', 'smp_canary', '{"locale":"en"}', now())`,
      [accountId, workspaceId, connectionId],
    );

    const configured = await scheduler(accountId);
    expect(await schedulerKeys()).toContain('tick.xb-canary');
    const handlers = configured.get<TickHandlers>(TICK_HANDLERS);
    await expect(handlers['tick.xb-canary']?.()).resolves.toEqual({ canary: 'checked', missing: 0 });
    expect(commands).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          accountId,
          workspaceId,
          handle: 'smp_canary',
          locale: 'en',
          session: SESSION.toString('base64'),
        }) as unknown,
      }),
    ]);
    await configured.close();
    opened.splice(opened.indexOf(configured), 1);

    await scheduler();
    expect(await schedulerKeys()).not.toContain('tick.xb-canary');
  });
});
