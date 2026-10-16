import 'reflect-metadata';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { InvitationMessage, InvitationNotifier } from '@smp/core';
import { createSmtpMailer, deliverEmail } from '@smp/emails';
import { NOTIFICATIONS_QUEUE, parseNotifyDispatch } from '@smp/queue';
import {
  startMailpit,
  startRedis,
  startTestDatabase,
  type StartedMailpit,
  type StartedRedis,
  type TestDatabase,
} from '@smp/testing';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Server } from 'node:http';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadApiEnv, type ApiEnv } from '../../src/config/api-env';
import { INVITATION_NOTIFIER } from '../../src/modules/tenancy/invitation-notifier';

export const APP_ORIGIN = 'http://localhost:3000';

export interface ApiTestApp {
  app: NestExpressApplication;
  server: Server;
  env: ApiEnv;
  database: TestDatabase;
  mailpit: StartedMailpit;
  /** Invitations "sent" so far, with their tokens. */
  invitations: InvitationMessage[];
  close: () => Promise<void>;
}

export interface ApiTestOptions {
  /**
   * Keep invitations out of the queue and hand their tokens to the test (default). Off, the
   * invitation emails go through the queue to Mailpit like every other email.
   */
  captureInvitations?: boolean;
}

/**
 * Starts the API with the pipeline of main.ts against fresh containers, plus a consumer of the
 * notifications queue that delivers like the worker role "notify" does.
 */
export async function startApiTestApp(options: ApiTestOptions = {}): Promise<ApiTestApp> {
  const [database, redis, mailpit]: [TestDatabase, StartedRedis, StartedMailpit] = await Promise.all([
    startTestDatabase(),
    startRedis(),
    startMailpit(),
  ]);
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    APP_URL: APP_ORIGIN,
    DATABASE_URL: database.url('app_user'),
    DATABASE_SYSTEM_URL: database.url('app_system'),
    REDIS_URL: redis.url,
    // Object storage is not needed before phase 3; the readiness check is not exercised here.
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'smp-test',
    S3_ACCESS_KEY_ID: 'test-access-key',
    S3_SECRET_ACCESS_KEY: 'test-secret-key',
    BETTER_AUTH_SECRET: 'test-only-better-auth-secret-do-not-use-elsewhere',
    BETTER_AUTH_URL: APP_ORIGIN,
  });

  const mailer = createSmtpMailer({ url: mailpit.smtpUrl, from: 'noreply@smp.test' });
  const notifications = new Worker(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      const payload = parseNotifyDispatch(job.data);
      await deliverEmail(mailer, payload.to, payload.email);
    },
    { connection: new Redis(redis.url, { maxRetriesPerRequest: null }) },
  );

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
    close: async () => {
      await app.close();
      await notifications.close();
      mailer.close();
      await Promise.all([database.stop(), redis.stop(), mailpit.stop()]);
    },
  };
}
