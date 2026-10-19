import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createLogger } from '@smp/observability';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { startMetricsServer } from './common/metrics/metrics';
import { loadApiEnv } from './config/api-env';

async function bootstrap(): Promise<void> {
  // Fails with a readable message before any connection is opened.
  const env = loadApiEnv(process.env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    bufferLogs: true,
    bodyParser: false,
  });
  configureApp(app, env);

  await app.listen(env.API_PORT, '0.0.0.0');
  // The metrics on a port of their own, which the reverse proxy does not reach (guide step 8.7).
  if (env.API_METRICS_PORT > 0) {
    startMetricsServer(env.API_METRICS_PORT);
  }
  createLogger({ service: 'api', environment: env.NODE_ENV, level: env.LOG_LEVEL }).info(
    { port: env.API_PORT, metricsPort: env.API_METRICS_PORT },
    'api.started',
  );
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown startup error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
