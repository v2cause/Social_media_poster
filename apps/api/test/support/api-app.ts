import 'reflect-metadata';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import {
  ProcessAsset,
  RenderAttachedMedia,
  systemClock,
  uuidV7Ids,
  type InvitationMessage,
  type InvitationNotifier,
} from '@smp/core';
import { createPrismaClient, PrismaMediaUnitOfWork } from '@smp/db';
import { createSmtpMailer, deliverEmail } from '@smp/emails';
import { S3Storage, SharpImageProcessor, storageConfigOf } from '@smp/media';
import {
  MEDIA_PROCESS,
  MEDIA_QUEUE,
  NOTIFICATIONS_QUEUE,
  parseMediaProcess,
  parseMediaRender,
  parseNotifyDispatch,
} from '@smp/queue';
import {
  startMailpit,
  startObjectStorage,
  startRedis,
  startTestDatabase,
  type StartedMailpit,
  type StartedObjectStorage,
  type StartedRedis,
  type TestDatabase,
} from '@smp/testing';
import { Worker } from 'bullmq';
import type { Server } from 'node:http';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadApiEnv, type ApiEnv } from '../../src/config/api-env';
import { AI_RATE_LIMITS, type AiRateLimits } from '../../src/modules/content/ai-rate-limiter';
import { INVITATION_NOTIFIER } from '../../src/modules/tenancy/invitation-notifier';

export const APP_ORIGIN = 'http://localhost:3000';
/** The token keyring of the tests, as in .env.test. */
export const TEST_TOKEN_KEKS = 'test-kek:c21wLXRlc3Qta2VrLW1hdGVyaWFsLTAwMDAwMDAwMDA=';
/** The session keyring of the tests, which seals the logins of X. */
export const TEST_SESSION_KEKS = 'test-session-kek:c21wLXRlc3Qtc2Vzc2lvbi1rZWstbWF0ZXJpYWwtMDA=';
export const TEST_BUCKET = 'smp-test-media';

export interface ApiTestApp {
  app: NestExpressApplication;
  server: Server;
  env: ApiEnv;
  database: TestDatabase;
  mailpit: StartedMailpit;
  /** Invitations "sent" so far, with their tokens. */
  invitations: InvitationMessage[];
  /** SeaweedFS, when the app was started with objectStorage. */
  objectStorage: StartedObjectStorage | null;
  close: () => Promise<void>;
}

export interface ApiTestOptions {
  /**
   * Keep invitations out of the queue and hand their tokens to the test (default). Off, the
   * invitation emails go through the queue to Mailpit like every other email.
   */
  captureInvitations?: boolean;
  /** Other limits of the AI routes, for tests that make many AI calls in a minute. */
  aiRateLimits?: AiRateLimits;
  /** Further environment variables, for example STRIPE_API_BASE. */
  env?: Record<string, string>;
  /**
   * Start SeaweedFS with a bucket and process the media queue like the worker role "media" does.
   * Off, the storage settings point nowhere; presigning works offline, uploads do not.
   */
  objectStorage?: boolean;
}

/** SeaweedFS with the bucket of the tests, and the settings of the API for it. */
async function startStorage(): Promise<{ storage: StartedObjectStorage; env: Record<string, string> }> {
  const storage = await startObjectStorage();
  const admin = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: true,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
  });
  try {
    await admin.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
  } finally {
    admin.destroy();
  }
  return {
    storage,
    env: {
      S3_ENDPOINT: storage.endpoint,
      S3_REGION: storage.region,
      S3_BUCKET: TEST_BUCKET,
      S3_ACCESS_KEY_ID: storage.accessKeyId,
      S3_SECRET_ACCESS_KEY: storage.secretAccessKey,
    },
  };
}

/**
 * Starts the API with the pipeline of main.ts against fresh containers, plus a consumer of the
 * notifications queue that delivers like the worker role "notify" does.
 */
export async function startApiTestApp(options: ApiTestOptions = {}): Promise<ApiTestApp> {
  const [database, redis, mailpit, objectStorage] = await Promise.all([
    startTestDatabase(),
    startRedis(),
    startMailpit(),
    options.objectStorage ? startStorage() : Promise.resolve(null),
  ]);
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    APP_URL: APP_ORIGIN,
    DATABASE_URL: database.url('app_user'),
    DATABASE_SYSTEM_URL: database.url('app_system'),
    REDIS_URL: redis.url,
    // Without objectStorage the storage settings point nowhere; the readiness check is not
    // exercised here.
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_REGION: 'us-east-1',
    S3_BUCKET: TEST_BUCKET,
    S3_ACCESS_KEY_ID: 'test-access-key',
    S3_SECRET_ACCESS_KEY: 'test-secret-key',
    ...objectStorage?.env,
    BETTER_AUTH_SECRET: 'test-only-better-auth-secret-do-not-use-elsewhere',
    BETTER_AUTH_URL: APP_ORIGIN,
    TOKEN_KEKS: TEST_TOKEN_KEKS,
    TOKEN_KEK_ACTIVE: 'test-kek',
    SESSION_KEKS: TEST_SESSION_KEKS,
    SESSION_KEK_ACTIVE: 'test-session-kek',
    // The deterministic mock provider; automated tests never call the Claude API (architecture 7).
    AI_PROVIDER: 'mock',
    ...options.env,
  });

  const mailer = createSmtpMailer({ url: mailpit.smtpUrl, from: 'noreply@smp.test' });
  const notifications = new Worker(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      const payload = parseNotifyDispatch(job.data);
      // The API queues emails only; events come from the outbox relay of the worker.
      if (payload.channel === 'email') {
        await deliverEmail(mailer, payload.to, payload.email);
      }
    },
    { connection: { url: redis.url, maxRetriesPerRequest: null } },
  );
  // A worker closed while it still starts leaves an unhandled rejection in BullMQ; the tests
  // close quickly, so the consumers are ready before the first test.
  const media = objectStorage ? startMediaConsumer(env, redis) : null;
  await Promise.all([notifications.waitUntilReady(), media?.worker.waitUntilReady()]);

  const invitations: InvitationMessage[] = [];
  const notifier: InvitationNotifier = {
    invitationCreated: (message) => {
      invitations.push(message);
      return Promise.resolve();
    },
  };
  const builder = Test.createTestingModule({ imports: [AppModule.register(env)] });
  if (options.captureInvitations !== false) {
    builder.overrideProvider(INVITATION_NOTIFIER).useValue(notifier);
  }
  if (options.aiRateLimits) {
    builder.overrideProvider(AI_RATE_LIMITS).useValue(options.aiRateLimits);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  configureApp(app, env);
  await app.init();

  return {
    app,
    server: app.getHttpServer(),
    env,
    database,
    mailpit,
    invitations,
    objectStorage: objectStorage?.storage ?? null,
    close: async () => {
      await app.close();
      await notifications.close();
      await media?.close();
      mailer.close();
      await Promise.all([database.stop(), redis.stop(), mailpit.stop(), objectStorage?.storage.stop()]);
    },
  };
}

/** Processes the media jobs like the worker role "media", with the real image pipeline. */
function startMediaConsumer(
  env: ApiEnv,
  redis: StartedRedis,
): { worker: Worker; close: () => Promise<void> } {
  const base = createPrismaClient(env.DATABASE_URL);
  const storage = new S3Storage(storageConfigOf(env));
  const deps = {
    unitOfWork: new PrismaMediaUnitOfWork(base),
    storage,
    processor: new SharpImageProcessor(),
    clock: systemClock,
    ids: uuidV7Ids,
  };
  const process = new ProcessAsset(deps);
  const render = new RenderAttachedMedia(deps);
  const worker = new Worker(
    MEDIA_QUEUE,
    async (job) => {
      await (job.name === MEDIA_PROCESS
        ? process.execute(parseMediaProcess(job.data))
        : render.execute(parseMediaRender(job.data)));
    },
    { connection: { url: redis.url, maxRetriesPerRequest: null } },
  );
  return {
    worker,
    close: async () => {
      await worker.close();
      storage.destroy();
      await base.$disconnect();
    },
  };
}
