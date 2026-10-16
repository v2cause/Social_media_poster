import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import helmet from 'helmet';
import { cleanupOpenApiDoc, ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';

import { requestIdMiddleware } from './common/request-id.middleware';
import { createOriginCheckMiddleware } from './common/security/origin-check.middleware';
import type { ApiEnv } from './config/api-env';
import { AUTH, type Auth } from './modules/identity/auth';

/**
 * The HTTP pipeline of the API, shared by main.ts and the integration tests. The order matters:
 * Better Auth reads the raw request body, so it is mounted before the body parsers.
 */
export function configureApp(app: NestExpressApplication, env: ApiEnv): void {
  app.useLogger(app.get(Logger));

  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(requestIdMiddleware);
  app.use(helmet());

  // Before the auth handler: Better Auth accepts a sign-in without cookies from any origin,
  // which would allow login CSRF.
  app.use(createOriginCheckMiddleware(env.APP_URL));

  // Express 5 needs the named wildcard (Better Auth docs, Express integration).
  const server = app.getHttpAdapter().getInstance();
  server.all('/api/auth/*splat', toNodeHandler(app.get<Auth>(AUTH)));

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
}
