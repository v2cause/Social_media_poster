import { Global, Module } from '@nestjs/common';
import { EntitlementsService, systemClock, type PlanUsage } from '@smp/core';
import {
  PrismaPlanUsage,
  PrismaSubscriptionReader,
  type PrismaClient,
  type SystemPrismaClient,
} from '@smp/db';

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
      inject: [DATABASE_CLIENT],
      useFactory: (base: PrismaClient) =>
        new EntitlementsService({ subscriptions: new PrismaSubscriptionReader(base), clock: systemClock }),
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
