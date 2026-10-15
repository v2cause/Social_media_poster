import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { createLogger } from '@smp/observability';
import { Logger } from 'nestjs-pino';

import { parseRoles } from './roles';
import { loadWorkerEnv } from './worker-env';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // Fails before any connection is opened. Only the processors of WORKER_ROLES are loaded.
  const env = loadWorkerEnv(process.env);
  const roles = parseRoles(env.WORKER_ROLES);

  const app = await NestFactory.createApplicationContext(WorkerModule.forRoles(roles, env), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // SIGTERM closes the BullMQ workers first, so the job in progress finishes before the exit.
  app.enableShutdownHooks();

  createLogger({ service: 'worker', environment: env.NODE_ENV, level: env.LOG_LEVEL }).info(
    { roles },
    'worker.started',
  );
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown startup error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
