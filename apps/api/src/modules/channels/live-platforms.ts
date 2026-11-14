import { Logger } from '@nestjs/common';
import { systemClock } from '@smp/core';
import { liveAdapters, PlatformRateLimiter, type LiveAdapterBuilders } from '@smp/platform-adapters';
import type Redis from 'ioredis';

import type { ApiEnv } from '../../config/api-env';

/**
 * The real adapters of the live platforms for connecting accounts (guide steps 4.12 to 4.14). The
 * API shares the outgoing rate limits with the workers in Redis.
 */
export function livePlatforms(env: ApiEnv, redis: Redis): LiveAdapterBuilders {
  const logger = new Logger('PlatformHttp');
  return liveAdapters(env, {
    clock: systemClock,
    limiter: PlatformRateLimiter.redis(redis),
    logger: {
      info: (fields, message) => {
        logger.log(fields, message);
      },
      warn: (fields, message) => {
        logger.warn(fields, message);
      },
    },
  });
}
