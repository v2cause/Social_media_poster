import type { XBrowserKillSignal } from '@smp/core';
import { XB_KEYS } from '@smp/x-browser';
import type Redis from 'ioredis';

/**
 * The kill switch as the browser worker sees it (guide step 6.1): a key in Redis, because the
 * browser worker has no database. Set while the switch is on; every command is refused then.
 */
export class RedisXBrowserKillSignal implements XBrowserKillSignal {
  constructor(private readonly redis: Redis) {}

  async set(active: boolean): Promise<void> {
    if (active) {
      await this.redis.set(XB_KEYS.kill, '1');
    } else {
      await this.redis.del(XB_KEYS.kill);
    }
  }
}
