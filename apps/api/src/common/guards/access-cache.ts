import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { z } from 'zod';

import { REDIS_CLIENT } from '../../infrastructure/clients.module';
import { accessCacheInvalidationFailures } from '../metrics/metrics';

// Membership lookups of the guards, cached for 60 s per user (architecture 10). Changes to a
// membership drop the user's entries at once. Only granted access is cached, so a new member
// never waits for an expiry. If Redis fails, the guards ask the database.

const TTL_SECONDS = 60;
const cachedAccess = z.object({
  organizationId: z.string(),
  organizationName: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']),
  workspaceId: z.string().optional(),
  // Since when the organization waits for its erasure (guide step 8.2).
  deletedAt: z.iso.datetime().nullable().default(null),
  // Whether its members need a second factor (guide step 8.4).
  requireTwoFactor: z.boolean().default(false),
});
export type CachedAccess = z.output<typeof cachedAccess>;

const keyOf = (userId: string) => `smp:access:${userId}`;

@Injectable()
export class AccessCache {
  private readonly logger = new Logger(AccessCache.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(userId: string, field: string): Promise<CachedAccess | null> {
    try {
      const raw = await this.redis.hget(keyOf(userId), field);
      if (raw === null) {
        return null;
      }
      const parsed = cachedAccess.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      this.logger.warn({ err: error }, 'access_cache.read_failed');
      return null;
    }
  }

  async set(userId: string, field: string, access: CachedAccess): Promise<void> {
    try {
      await this.redis
        .multi()
        .hset(keyOf(userId), field, JSON.stringify(access))
        .expire(keyOf(userId), TTL_SECONDS, 'NX')
        .exec();
    } catch (error) {
      this.logger.warn({ err: error }, 'access_cache.write_failed');
    }
  }

  /** Drops every cached access of a user, after a role change, removal or leave. */
  async invalidateUser(userId: string): Promise<void> {
    await this.invalidateUsers([userId]);
  }

  /** Drops the cached access of several users, for example of every member after a deletion. */
  async invalidateUsers(userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    try {
      await this.redis.del(...userIds.map(keyOf));
    } catch (error) {
      accessCacheInvalidationFailures.inc();
      this.logger.warn({ err: error }, 'access_cache.invalidate_failed');
    }
  }
}
