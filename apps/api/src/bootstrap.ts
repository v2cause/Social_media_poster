import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import helmet from 'helmet';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';
import { pinoHttp, type Options as HttpLoggingOptions } from 'pino-http';

import { HTTP_LOGGING } from './common/logging/http-logging';
import { authRateLimitEvents } from './common/logging/security-events';
import { httpMetrics } from './common/metrics/metrics';
import { requestIdMiddleware } from './common/request-id.middleware';
import { authBodyLimit, bodyErrors, noStore } from './common/security/body-limits.middleware';
import { createOriginCheckMiddleware } from './common/security/origin-check.middleware';
import type { ApiEnv } from './config/api-env';
import { AUTH, type Auth } from './modules/identity/auth';
import { createOpenApiDocument } from './openapi';

/**
 * The HTTP pipeline of the API, shared by main.ts and the integration tests. The order matters:
 * Better Auth reads the raw request body, so it is mounted before the body parsers.
 */
export function configureApp(app: NestExpressApplication, env: ApiEnv): void {
  app.useLogger(app.get(Logger));

  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(requestIdMiddleware);
  app.use(httpMetrics);
  // The defaults of helmet, with nothing that may frame the API or set a <base> for it.
  app.use(
    helmet({ contentSecurityPolicy: { directives: { baseUri: ["'none'"], frameAncestors: ["'none'"] } } }),
  );
  app.use(noStore);

  // Before the auth handler: Better Auth accepts a sign-in without cookies from any origin,
  // which would allow login CSRF.
  app.use(createOriginCheckMiddleware(env.APP_URL));

  // Express 5 needs the named wildcard (Better Auth docs, Express integration). Better Auth reads
  // the body without a limit, so the limit comes first. It answers before the middleware of Nest,
  // so its routes get their request line here.
  const server = app.getHttpAdapter().getInstance();
  server.use(
    '/api/auth',
    pinoHttp(app.get<HttpLoggingOptions>(HTTP_LOGGING)),
    authBodyLimit,
    authRateLimitEvents,
  );
  server.all('/api/auth/*splat', toNodeHandler(app.get<Auth>(AUTH)));

  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(bodyErrors);

  app.useGlobalPipes(new ZodValidationPipe());
  // Responses pass through the DTO schema, so internal fields cannot leak out.
  app.useGlobalInterceptors(new ZodSerializerInterceptor(app.get(Reflector)));

  if (env.NODE_ENV !== 'production') {
    SwaggerModule.setup('api/docs', app, createOpenApiDocument(app));
  }

  app.enableShutdownHooks();
}
