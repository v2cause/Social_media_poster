import type { Provider } from '@nestjs/common';
import { riskTextOf, X_BROWSER_RISK } from '@smp/contracts';
import {
  DisableXBrowser,
  EnableXBrowser,
  EntitlementsService,
  GetBrowserLogin,
  GetXBrowserAdmin,
  GetXBrowserStatus,
  planAccountLimits,
  SetXBrowserKillSwitch,
  SetXBrowserOrganization,
  StartBrowserLogin,
  SubmitBrowserLoginCode,
  systemClock,
  uuidV7Ids,
  XBrowserGate,
  XBrowserUnavailableError,
  type BrowserLoginDependencies,
  type BrowserLoginQueue,
  type SecretSealer,
  type XBrowserAccessDependencies,
  type XBrowserAdminDependencies,
  type PlanUsage,
} from '@smp/core';
import { sealerFromEnv } from '@smp/crypto';
import {
  PrismaChannelUnitOfWork,
  PrismaXBrowserAdminStore,
  PrismaXBrowserUnitOfWork,
  type PrismaClient,
  type SystemPrismaClient,
} from '@smp/db';
import {
  BullBrowserLoginQueue,
  RedisBrowserLoginStore,
  RedisXBrowserKillSignal,
} from '@smp/platform-adapters';
import { LiveBrowserLoginEvents, LiveEventPublisher } from '@smp/queue';
import { xbLoginAad } from '@smp/x-browser';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';

import { RequestOriginService } from '../../common/cls/tenant-context';
import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import {
  DATABASE_CLIENT,
  REDIS_CLIENT,
  SYSTEM_DATABASE_CLIENT,
  XB_COMMANDS_JOBS_QUEUE,
} from '../../infrastructure/clients.module';
import { PLAN_USAGE } from '../billing/plan.module';

// The X browser of the API (guide steps 6.1 and 6.4): status and switching per workspace as
// app_user in its tenant, the switches of the platform admins as app_system, and the interactive
// login, whose credentials and codes the API seals with the session keyring for the browser
// worker. The risk text and its hashes come from @smp/contracts.

export const X_BROWSER_ACCESS = Symbol('X_BROWSER_ACCESS');
export const X_BROWSER_ADMIN = Symbol('X_BROWSER_ADMIN');
export const X_BROWSER_LOGIN = Symbol('X_BROWSER_LOGIN');

// Where the deployment runs no browser worker, the gate refuses a login before either is asked.
const unavailable = (): Promise<never> => Promise.reject(new XBrowserUnavailableError());
const closedSealer: SecretSealer = { seal: unavailable, open: unavailable };
const closedQueue: BrowserLoginQueue = { start: unavailable };

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
  {
    provide: X_BROWSER_LOGIN,
    inject: [
      API_ENV,
      DATABASE_CLIENT,
      REDIS_CLIENT,
      XB_COMMANDS_JOBS_QUEUE,
      RequestOriginService,
      X_BROWSER_ACCESS,
      EntitlementsService,
      PLAN_USAGE,
    ],
    useFactory: (
      env: ApiEnv,
      base: PrismaClient,
      redis: Redis,
      commands: Queue | null,
      origin: RequestOriginService,
      access: XBrowserAccessDependencies,
      entitlements: EntitlementsService,
      usage: PlanUsage,
    ): BrowserLoginDependencies => ({
      logins: new RedisBrowserLoginStore(redis),
      queue: commands ? new BullBrowserLoginQueue(commands) : closedQueue,
      events: new LiveBrowserLoginEvents(new LiveEventPublisher(redis)),
      sealer: env.FEATURE_X_BROWSER_GLOBAL ? sealerFromEnv('sessions', env) : closedSealer,
      aad: xbLoginAad,
      gate: new XBrowserGate(access),
      accounts: planAccountLimits(entitlements, usage),
      unitOfWork: new PrismaChannelUnitOfWork(base, () => origin.get()),
      clock: systemClock,
      ids: uuidV7Ids,
    }),
  },
  ...[StartBrowserLogin, GetBrowserLogin, SubmitBrowserLoginCode].map((UseCase) => ({
    provide: UseCase,
    inject: [X_BROWSER_LOGIN],
    useFactory: (deps: BrowserLoginDependencies) => new UseCase(deps),
  })),
];
