import 'reflect-metadata';

import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createLogger } from '@smp/observability';
import express from 'express';
import helmet from 'helmet';
import { cleanupOpenApiDoc, ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { requestIdMiddleware } from './common/request-id.middleware';
import { loadApiEnv } from './config/api-env';

async function bootstrap(): Promise<void> {
  // Fails with a readable message before any connection is opened.
  const env = loadApiEnv(process.env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));

  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(requestIdMiddleware);
  app.use(helmet());
  // Phase 1: the Better Auth handler is mounted here, before the body parsers.
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.useGlobalPipes(new ZodValidationPipe());
  // Responses pass through the DTO schema, so internal fields cannot leak out.
  app.useGlobalInterceptors(new ZodSerializerInterceptor(app.get(Reflector)));

  if (env.NODE_ENV !== 'production') {
    const document = cleanupOpenApiDoc(
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('Social Media Poster API').setVersion('0.0.0').build(),
      ),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');
  createLogger({ service: 'api', environment: env.NODE_ENV, level: env.LOG_LEVEL }).info(
    { port: env.API_PORT },
    'api.started',
  );
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown startup error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
