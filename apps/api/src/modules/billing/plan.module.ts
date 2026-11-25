import { Global, Module } from '@nestjs/common';
import { EntitlementsService, LocalModeSubscriptionReader, systemClock, type PlanUsage } from '@smp/core';
import {
  PrismaPlanUsage,
  PrismaSubscriptionReader,
  type PrismaClient,
  type SystemPrismaClient,
} from '@smp/db';

import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { DATABASE_CLIENT, SYSTEM_DATABASE_CLIENT } from '../../infrastructure/clients.module';

/** What an organization uses of the limits its plan counts across its workspaces. */
export const PLAN_USAGE = Symbol('PLAN_USAGE');

/**
 * The plan of an organization for every module of the API (guide step 7.4): its entitlements,
 * read from the subscription with every change so that a webhook takes effect with the next
 * request, and its usage across the workspaces.
 */
@Global()
@Module({
  providers: [
    {
      provide: EntitlementsService,
      inject: [DATABASE_CLIENT, API_ENV],
      useFactory: (base: PrismaClient, env: Pick<ApiEnv, 'LOCAL_MODE'>) => {
        const subscriptions = new PrismaSubscriptionReader(base);
        // The single-user mode has no billing: every organization is active without limits (ADR 0046).
        return new EntitlementsService({
          subscriptions: env.LOCAL_MODE ? new LocalModeSubscriptionReader(subscriptions) : subscriptions,
          clock: systemClock,
        });
      },
    },
    {
      provide: PLAN_USAGE,
      inject: [SYSTEM_DATABASE_CLIENT],
      useFactory: (system: SystemPrismaClient): PlanUsage => new PrismaPlanUsage(system),
    },
  ],
  exports: [EntitlementsService, PLAN_USAGE],
})
export class PlanModule {}
