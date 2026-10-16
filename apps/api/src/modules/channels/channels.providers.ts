import type { Provider } from '@nestjs/common';
import {
  CompleteAuthorization,
  ConfirmConnection,
  DisconnectAccount,
  GetPendingConnection,
  StartConnection,
  systemClock,
  uuidV7Ids,
  type ChannelDependencies,
} from '@smp/core';
import { oauthRandom, sealerFromEnv } from '@smp/crypto';
import { ChannelReadModel, PrismaChannelUnitOfWork, type PrismaClient } from '@smp/db';
import { createAdapterRegistry, RedisMockPlatformStore, type AdapterRegistry } from '@smp/platform-adapters';
import type Redis from 'ioredis';

import { RequestOriginService } from '../../common/cls/tenant-context';
import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../../infrastructure/clients.module';
import { mockAuthorizeUrl, oauthCallbackUrl } from './oauth-urls';
import { RedisOAuthStateStore, RedisPendingConnectionStore } from './redis-oauth-stores';

export const ADAPTER_REGISTRY = Symbol('ADAPTER_REGISTRY');
export const CHANNEL_DEPENDENCIES = Symbol('CHANNEL_DEPENDENCIES');
export const CHANNEL_READ_MODEL = Symbol('CHANNEL_READ_MODEL');

const CHANNEL_USE_CASES = [
  StartConnection,
  CompleteAuthorization,
  GetPendingConnection,
  ConfirmConnection,
  DisconnectAccount,
] as const;

/** The channel use cases of the core, wired to the adapters of the API (guide step 4.5). */
export const channelProviders: Provider[] = [
  {
    // The platforms of PLATFORM_MODE_*; the live adapters join with guide steps 4.12 to 4.14. The
    // mock platforms keep their state in Redis, shared with the workers.
    provide: ADAPTER_REGISTRY,
    inject: [API_ENV, REDIS_CLIENT],
    useFactory: (env: ApiEnv, redis: Redis): AdapterRegistry =>
      createAdapterRegistry({
        env,
        mock: {
          store: new RedisMockPlatformStore(redis),
          clock: systemClock,
          authorizeUrl: mockAuthorizeUrl(env.APP_URL),
        },
      }),
  },
  {
    provide: CHANNEL_DEPENDENCIES,
    inject: [API_ENV, DATABASE_CLIENT, REDIS_CLIENT, RequestOriginService, ADAPTER_REGISTRY],
    useFactory: (
      env: ApiEnv,
      base: PrismaClient,
      redis: Redis,
      origin: RequestOriginService,
      registry: AdapterRegistry,
    ): ChannelDependencies => ({
      unitOfWork: new PrismaChannelUnitOfWork(base, () => origin.get()),
      connectors: registry,
      states: new RedisOAuthStateStore(redis),
      pendings: new RedisPendingConnectionStore(redis, systemClock),
      sealer: sealerFromEnv('tokens', env),
      random: oauthRandom,
      clock: systemClock,
      ids: uuidV7Ids,
      callbackUrl: (platform) => oauthCallbackUrl(env.APP_URL, platform),
    }),
  },
  {
    provide: CHANNEL_READ_MODEL,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) => new ChannelReadModel(base),
  },
  ...CHANNEL_USE_CASES.map((UseCase) => ({
    provide: UseCase,
    inject: [CHANNEL_DEPENDENCIES],
    useFactory: (deps: ChannelDependencies) => new UseCase(deps),
  })),
];
