import { Logger } from '@nestjs/common';
import { systemClock } from '@smp/core';
import { liveAdapters, PlatformRateLimiter, type LiveAdapterBuilders } from '@smp/platform-adapters';
import type Redis from 'ioredis';

import type { WorkerEnv } from '../worker-env';

/**
 * The real adapters of the live platforms (guide steps 4.12 to 4.14). All workers share the
 * outgoing rate limits in Redis; every platform call is logged without query, headers or body.
 */
export function livePlatforms(env: WorkerEnv, redis: Redis): LiveAdapterBuilders {
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
