import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { X_BROWSER_RISK } from '@smp/contracts';
import { PUBLISH_QUEUE, PublishProducer } from '@smp/queue';
import { startRedis, startTestDatabase, type StartedRedis, type TestDatabase } from '@smp/testing';
import {
  parseXbCommand,
  XB_COMMANDS_QUEUE,
  XB_REPORT,
  XB_RESULTS_QUEUE,
  type XbCommand,
  type XbOutcome,
} from '@smp/x-browser';
import { Queue, Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRoles } from '../src/roles';
import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';

// Guide steps 6.3 and 6.6 through the role "publisher": a post of a browser connection of X goes
// to xb-commands with the sealed session and comes back as the return value of its job, the new
// session of the report replaces the old one, a challenge pauses the variant and asks for a new
// login, and with the kill switch on no command leaves at all. The browser worker is a stand-in
// on the queue; its own tests run the browser.

const SESSION = Buffer.from('sealed-session-of-the-test');
const NEW_SESSION = Buffer.from('sealed-session-after-the-task');

interface Workspace {
  organizationId: string;
  workspaceId: string;
}

describe('X without the API in the role "publisher"', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let publishQueue: Queue | undefined;
  let results: Queue | undefined;
  let browserWorker: Worker | undefined;
  let publisher: INestApplicationContext | undefined;
  const commands: XbCommand<'publish'>[] = [];
  /** How the stand-in of the browser worker answers the next post. */
  let answer: (command: XbCommand<'publish'>) => XbOutcome<'publish'> = () => ({
    ok: false,
    error: { code: 'TRANSIENT', message: 'not set' },
  });

  const started = () => {
    if (!database || !redis || !publishQueue || !results) {
      throw new Error('not started');
    }
    return { database, redis, publishQueue, results };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const waitFor = async (what: string, condition: () => Promise<boolean>, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(100);
    }
  };

  /** A workspace whose organization may use the X browser, switched on with the current text. */
  const seedWorkspace = async (): Promise<Workspace> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Org', now())`, [
      organizationId,
    ]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, $3, 'XB', 'Europe/Berlin', 'de', now())`,
      [workspaceId, organizationId, `xb-${workspaceId.slice(0, 8)}`],
    );
    await query(
      `INSERT INTO feature_flag (id, key, organization_id, workspace_id, enabled, updated_at)
       VALUES ($1, 'x_browser_automation', $3, NULL, true, now()),
              ($2, 'x_browser_automation', $3, $4, true, now())`,
      [randomUUID(), randomUUID(), organizationId, workspaceId],
    );
    await query(
      `INSERT INTO risk_acknowledgement (id, workspace_id, user_id, subject, text_version, text_hash, locale, accepted_at)
       VALUES ($1, $2, $3, 'x_browser', $4, $5, 'de', now())`,
      [randomUUID(), workspaceId, randomUUID(), X_BROWSER_RISK.version, X_BROWSER_RISK.hashes.de],
    );
    return { organizationId, workspaceId };
  };

  /** A browser connection of X with one account and a queued variant on it. */
  const seedVariant = async ({ workspaceId }: Workspace) => {
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const postId = randomUUID();
    const variantId = randomUUID();
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                      session_sealed, updated_at)
       VALUES ($1, $2, 'X', 'BROWSER', '1234567890', 'SMP Demo', $3, now())`,
      [connectionId, workspaceId, SESSION],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, handle,
                                   settings, updated_at)
       VALUES ($1, $2, $3, 'X', 'PROFILE', '1234567890', 'SMP Demo', 'smp_demo', '{"locale":"en"}', now())`,
      [accountId, workspaceId, connectionId],
    );
    await query(
      `INSERT INTO post (id, workspace_id, brief, language, updated_at) VALUES ($1, $2, 'Brief', 'en', now())`,
      [postId, workspaceId],
    );
    await query(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, text, social_account_id,
                                 status, version, schedule_version, queued_at, updated_at)
       VALUES ($1, $2, $3, 'X', 't1', $4, $5, 'QUEUED', 2, 1, now(), now())`,
      [variantId, workspaceId, postId, `Launch day ${variantId}`, accountId],
    );
    return { connectionId, accountId, variantId };
  };
  const enqueue = (scope: Workspace, variantId: string) =>
    new PublishProducer(started().publishQueue).publish({
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      variantId,
      scheduleVersion: 1,
      trigger: 'now',
    });
  const variantOf = async (variantId: string) =>
    (
      await query<{ status: string; external_post_id: string | null; failure_code: string | null }>(
        'SELECT status, external_post_id, failure_code FROM post_variant WHERE id = $1',
        [variantId],
      )
    )[0];
  const connectionOf = async (connectionId: string) =>
    (
      await query<{ status: string; status_reason: string | null; session_sealed: Buffer }>(
        'SELECT status, status_reason, session_sealed FROM social_connection WHERE id = $1',
        [connectionId],
      )
    )[0];

  beforeAll(async () => {
    [database, redis] = await Promise.all([startTestDatabase(), startRedis()]);
    const connection = { url: redis.url };
    publishQueue = new Queue(PUBLISH_QUEUE, { connection });
    results = new Queue(XB_RESULTS_QUEUE, { connection });
    const reports = results;
    // The stand-in of the browser worker: it answers the post and reports the new session.
    browserWorker = new Worker(
      XB_COMMANDS_QUEUE,
      async (job: Job) => {
        const command = parseXbCommand('publish', job.data);
        commands.push(command);
        const outcome = answer(command);
        if (outcome.ok) {
          await reports.add(XB_REPORT, {
            kind: 'session.updated',
            organizationId: command.target.organizationId,
            workspaceId: command.target.workspaceId,
            connectionId: command.target.connectionId,
            externalUserId: command.target.externalUserId,
            session: NEW_SESSION.toString('base64'),
          });
        }
        return outcome;
      },
      { connection: { ...connection, maxRetriesPerRequest: null } },
    );
    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ROLES: 'publisher',
      WORKER_HEALTH_PORT: String(40_000 + Math.floor(Math.random() * 10_000)),
      REDIS_URL: redis.url,
      DATABASE_URL: database.url('app_user'),
      TOKEN_KEKS: `kek-test:${Buffer.alloc(32, 7).toString('base64')}`,
      TOKEN_KEK_ACTIVE: 'kek-test',
      S3_ENDPOINT: 'http://127.0.0.1:9',
      S3_REGION: 'eu-central-1',
      S3_BUCKET: 'media',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test-secret',
      FEATURE_X_BROWSER_GLOBAL: 'true',
    });
    publisher = await NestFactory.createApplicationContext(
      WorkerModule.forRoles(parseRoles(env.WORKER_ROLES), env),
      { logger: false },
    );
  });

  afterAll(async () => {
    await publisher?.close();
    await browserWorker?.close();
    await publishQueue?.close();
    await results?.close();
    await Promise.all([database?.stop(), redis?.stop()]);
  });

  it('posts through the browser worker and stores the session it reports', async () => {
    const scope = await seedWorkspace();
    const seeded = await seedVariant(scope);
    answer = () => ({
      ok: true,
      data: {
        externalPostId: '1846000000000000001',
        externalUrl: 'https://x.com/smp_demo/status/1846000000000000001',
        publishedAt: '2026-10-17T08:00:05.000Z',
      },
    });
    await enqueue(scope, seeded.variantId);
    await waitFor(
      'the published variant',
      async () => (await variantOf(seeded.variantId))?.status === 'PUBLISHED',
    );

    expect(await variantOf(seeded.variantId)).toMatchObject({ external_post_id: '1846000000000000001' });
    const command = commands.find((sent) => sent.target.accountId === seeded.accountId);
    expect(command).toMatchObject({
      text: `Launch day ${seeded.variantId}`,
      media: [],
      target: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        connectionId: seeded.connectionId,
        externalUserId: '1234567890',
        handle: 'smp_demo',
        locale: 'en',
        session: SESSION.toString('base64'),
      },
    });
    await waitFor(
      'the new session',
      async () => (await connectionOf(seeded.connectionId))?.session_sealed.equals(NEW_SESSION) ?? false,
    );
  });

  it('pauses the variant at a challenge and asks for a new login, without another try', async () => {
    const scope = await seedWorkspace();
    const seeded = await seedVariant(scope);
    answer = () => ({ ok: false, error: { code: 'CHALLENGE_REQUIRED', message: 'X asks for a check.' } });
    const before = commands.length;
    await enqueue(scope, seeded.variantId);
    await waitFor(
      'the paused variant',
      async () => (await variantOf(seeded.variantId))?.status === 'NEEDS_ATTENTION',
    );

    expect(await variantOf(seeded.variantId)).toMatchObject({ failure_code: 'CHALLENGE_REQUIRED' });
    expect(await connectionOf(seeded.connectionId)).toMatchObject({
      status: 'NEEDS_REAUTH',
      status_reason: 'CHALLENGE_REQUIRED',
    });
    await sleep(1_500);
    expect(commands.length - before).toBe(1);
  });

  it('sends no command at all while the kill switch is on', async () => {
    await query(
      `INSERT INTO feature_flag (id, key, organization_id, workspace_id, enabled, updated_at)
       VALUES ($1, 'x_browser_automation', NULL, NULL, false, now())`,
      [randomUUID()],
    );
    const scope = await seedWorkspace();
    const seeded = await seedVariant(scope);
    const before = commands.length;
    await enqueue(scope, seeded.variantId);
    await waitFor('the failed variant', async () => (await variantOf(seeded.variantId))?.status === 'FAILED');

    expect(await variantOf(seeded.variantId)).toMatchObject({ failure_code: 'ADAPTER_UNAVAILABLE' });
    expect(commands.length).toBe(before);
  });
});
