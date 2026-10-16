import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Params, LoggerModule } from 'nestjs-pino';
import { createLogger } from '@smp/observability';
import { uuidv7 } from 'uuidv7';

import { RequestContextModule } from './common/cls/request-context.module';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { httpLogSerializers } from './common/logging/http-log-serializers';
import type { ApiEnv } from './config/api-env';
import { ConfigModule } from './config/config.module';
import { ClientsModule } from './infrastructure/clients.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    const logger = createLogger({ service: 'api', environment: env.NODE_ENV, level: env.LOG_LEVEL });
    const pinoParams: Params = {
      pinoHttp: {
        logger,
        // The request-id middleware sets req.id before pino-http runs.
        genReqId: (req) => (req as { id?: string }).id ?? uuidv7(),
        autoLogging: {
          ignore: (req) => (req.url ?? '').startsWith('/api/health'),
        },
        serializers: httpLogSerializers,
      },
    };

    return {
      module: AppModule,
      imports: [
        ConfigModule.register(env),
        LoggerModule.forRoot(pinoParams),
        RequestContextModule,
        ClientsModule,
        HealthModule,
        IdentityModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    };
  }
}
