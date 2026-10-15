import { createLogger } from '@smp/observability';
import { type Job, Worker } from 'bullmq';
import Redis from 'ioredis';

import { loadBrowserWorkerEnv } from './env';

export const XB_COMMANDS_QUEUE = 'xb-commands';

// Phase 0: the host starts, connects and reports ready. No command is implemented yet.
// Login, publish and metrics flows arrive with phase 6 of the guide.
function bootstrap(): void {
  const env = loadBrowserWorkerEnv(process.env);
  const logger = createLogger({ service: 'browser-worker', environment: env.NODE_ENV, level: env.LOG_LEVEL });

  if (!env.FEATURE_X_BROWSER_GLOBAL) {
    logger.info('browser-worker.disabled');
    return;
  }

  // Workers block on their connection, so a failed command must not be retried forever.
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = new Worker(
    XB_COMMANDS_QUEUE,
    (job: Job) => {
      logger.warn({ jobId: job.id, queue: XB_COMMANDS_QUEUE }, 'xb.command.unsupported');
      return Promise.reject(new Error('X browser commands are not implemented yet'));
    },
    { connection },
  );

  worker.on('error', (error: Error) => {
    logger.error({ errorName: error.name }, 'browser-worker.error');
  });

  const shutdown = (): void => {
    // Closing the worker waits for the command in progress, then the connection is released.
    void worker
      .close()
      .then(() => connection.quit())
      .then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  logger.info({ queue: XB_COMMANDS_QUEUE }, 'browser-worker.ready');
}

try {
  bootstrap();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : 'unknown startup error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
