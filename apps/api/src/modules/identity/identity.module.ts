import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { PrismaClient } from '@smp/db';

import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { DATABASE_CLIENT } from '../../infrastructure/clients.module';
import { AUTH, createAuth } from './auth';
import { AuthGuard } from './auth.guard';
import { AuthMailer } from './auth-mailer';
import { MeController } from './me.controller';

@Module({
  controllers: [MeController],
  providers: [
    AuthMailer,
    {
      provide: AUTH,
      inject: [API_ENV, DATABASE_CLIENT, AuthMailer],
      useFactory: (env: ApiEnv, prisma: PrismaClient, mailer: AuthMailer) =>
        createAuth({ env, prisma, mailer, logger: new Logger('Auth') }),
    },
    // Global: every route needs a session unless it is marked @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AUTH],
})
export class IdentityModule {}
