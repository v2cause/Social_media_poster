import type { Provider } from '@nestjs/common';
import { riskTextOf, X_BROWSER_RISK } from '@smp/contracts';
import {
  DisableXBrowser,
  EnableXBrowser,
  GetXBrowserAdmin,
  GetXBrowserStatus,
  SetXBrowserKillSwitch,
  SetXBrowserOrganization,
  systemClock,
  uuidV7Ids,
  type XBrowserAccessDependencies,
  type XBrowserAdminDependencies,
} from '@smp/core';
import {
  PrismaXBrowserAdminStore,
  PrismaXBrowserUnitOfWork,
  type PrismaClient,
  type SystemPrismaClient,
} from '@smp/db';
import { RedisXBrowserKillSignal } from '@smp/platform-adapters';
import type Redis from 'ioredis';

import { RequestOriginService } from '../../common/cls/tenant-context';
import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { DATABASE_CLIENT, REDIS_CLIENT, SYSTEM_DATABASE_CLIENT } from '../../infrastructure/clients.module';

// The X browser of the API (guide step 6.1): status and switching per workspace as app_user in
// its tenant, the switches of the platform admins as app_system. The risk text and its hashes
// come from @smp/contracts.

export const X_BROWSER_ACCESS = Symbol('X_BROWSER_ACCESS');
export const X_BROWSER_ADMIN = Symbol('X_BROWSER_ADMIN');

export const xBrowserProviders: Provider[] = [
  {
    provide: X_BROWSER_ACCESS,
    inject: [API_ENV, DATABASE_CLIENT, RequestOriginService],
    useFactory: (
      env: ApiEnv,
      base: PrismaClient,
      origin: RequestOriginService,
    ): XBrowserAccessDependencies => ({
      unitOfWork: new PrismaXBrowserUnitOfWork(base, () => origin.get()),
      offered: env.FEATURE_X_BROWSER_GLOBAL,
      riskText: riskTextOf(X_BROWSER_RISK),
      clock: systemClock,
      ids: uuidV7Ids,
    }),
  },
  ...[GetXBrowserStatus, EnableXBrowser, DisableXBrowser].map((UseCase) => ({
    provide: UseCase,
    inject: [X_BROWSER_ACCESS],
    useFactory: (deps: XBrowserAccessDependencies) => new UseCase(deps),
  })),
  {
    provide: X_BROWSER_ADMIN,
    inject: [API_ENV, SYSTEM_DATABASE_CLIENT, REDIS_CLIENT],
    useFactory: (env: ApiEnv, system: SystemPrismaClient, redis: Redis): XBrowserAdminDependencies => ({
      store: new PrismaXBrowserAdminStore(system),
      killSignal: new RedisXBrowserKillSignal(redis),
      offered: env.FEATURE_X_BROWSER_GLOBAL,
    }),
  },
  ...[GetXBrowserAdmin, SetXBrowserKillSwitch, SetXBrowserOrganization].map((UseCase) => ({
    provide: UseCase,
    inject: [X_BROWSER_ADMIN],
    useFactory: (deps: XBrowserAdminDependencies) => new UseCase(deps),
  })),
];
