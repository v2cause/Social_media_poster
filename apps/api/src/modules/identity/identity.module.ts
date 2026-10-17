import { Logger, Module } from '@nestjs/common';
import type { PrismaClient } from '@smp/db';

import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { DATABASE_CLIENT } from '../../infrastructure/clients.module';
import { AUTH, createAuth } from './auth';
import { AuthMailer } from './auth-mailer';
import { MeController } from './me.controller';
import { PasswordCheck } from './password-check';
import { PlatformAdminGuard } from './platform-admin.guard';

@Module({
  controllers: [MeController],
  providers: [
    AuthMailer,
    PasswordCheck,
    PlatformAdminGuard,
    {
      provide: AUTH,
      inject: [API_ENV, DATABASE_CLIENT, AuthMailer],
      useFactory: (env: ApiEnv, prisma: PrismaClient, mailer: AuthMailer) =>
        createAuth({ env, prisma, mailer, logger: new Logger('Auth') }),
    },
  ],
  exports: [AUTH, PasswordCheck, PlatformAdminGuard],
})
export class IdentityModule {}
