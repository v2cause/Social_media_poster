import { randomUUID } from 'node:crypto';

import { startRedis, type StartedRedis } from '@smp/testing';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisMockPlatformStore, type MockPost } from '../src';

// The mock platforms keep their posts in Redis, so a second process (the API, a restarted
// worker) sees what the first one published (guide step 4.8).

describe('RedisMockPlatformStore', () => {
  let redis: StartedRedis | undefined;
  const clients: Redis[] = [];

  const store = (prefix: string): RedisMockPlatformStore => {
    if (!redis) {
      throw new Error('Redis is not running');
    }
    const client = new Redis(redis.url);
    clients.push(client);
    return new RedisMockPlatformStore(client, prefix);
  };

  beforeAll(async () => {
    redis = await startRedis();
  });

  afterAll(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    await redis?.stop();
  });

  it('shares posts, counts and flags between two connections', async () => {
    const prefix = `mock-${randomUUID()}:`;
    const [first, second] = [store(prefix), store(prefix)];
    const accountId = randomUUID();
    const post: MockPost = {
      externalPostId: 'mock-x-1',
      accountId,
      text: 'Hallo Kiel',
      contentHash: 'h1',
      publishedAt: new Date('2026-10-16T12:00:00Z'),
      deletedAt: null,
    };

    await first.save(post);
    await first.countCall('created', accountId);
    await second.countCall('created', accountId);

    await expect(second.find('mock-x-1')).resolves.toEqual(post);
    await expect(second.postsOf(accountId)).resolves.toEqual([post]);
    await expect(first.callCount('created', accountId)).resolves.toBe(2);
    await expect(first.setOnce('rate-limit:1')).resolves.toBe(true);
    await expect(second.setOnce('rate-limit:1')).resolves.toBe(false);
    await expect(store(`other-${prefix}`).find('mock-x-1')).resolves.toBeUndefined();
  });
});
