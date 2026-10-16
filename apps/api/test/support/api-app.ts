import 'reflect-metadata';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { InvitationMessage, InvitationNotifier } from '@smp/core';
import {
  startMailpit,
  startRedis,
  startTestDatabase,
  type StartedMailpit,
  type StartedRedis,
  type TestDatabase,
} from '@smp/testing';
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

/** Starts the API with the pipeline of main.ts against fresh containers. */
export async function startApiTestApp(): Promise<ApiTestApp> {
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
    SMTP_URL: mailpit.smtpUrl,
    MAIL_FROM: 'noreply@smp.test',
  });

  const invitations: InvitationMessage[] = [];
  const notifier: InvitationNotifier = {
    invitationCreated: (message) => {
      invitations.push(message);
      return Promise.resolve();
    },
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(INVITATION_NOTIFIER)
    .useValue(notifier)
    .compile();
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
      await Promise.all([database.stop(), redis.stop(), mailpit.stop()]);
    },
  };
}
