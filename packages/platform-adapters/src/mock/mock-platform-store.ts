import type Redis from 'ioredis';
import { z } from 'zod';

// What the mock platforms remember: published posts, the calls per account and one-time flags.
// The API and the workers share it in Redis, so a post outlives the worker that made it: the
// chaos test of guide step 4.8 stops a worker in the middle of a publish and counts the posts.
// Unit tests use the store in memory.

export interface MockPost {
  externalPostId: string;
  /** The SocialAccount the post went out for. */
  accountId: string;
  text: string;
  contentHash: string;
  publishedAt: Date;
  deletedAt: Date | null;
}

export interface MockPlatformStore {
  countCall(operation: string, accountId: string): Promise<void>;
  /** How often an operation ran for an account, for example publish. */
  callCount(operation: string, accountId: string): Promise<number>;
  /** Sets a flag once; true when it was not set yet. */
  setOnce(flag: string): Promise<boolean>;
  save(post: MockPost): Promise<void>;
  find(externalPostId: string): Promise<MockPost | undefined>;
  postsOf(accountId: string): Promise<MockPost[]>;
}

export class InMemoryMockPlatformStore implements MockPlatformStore {
  private readonly posts = new Map<string, MockPost>();
  private readonly calls = new Map<string, number>();
  private readonly flags = new Set<string>();

  countCall(operation: string, accountId: string): Promise<void> {
    const key = `${operation}:${accountId}`;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    return Promise.resolve();
  }

  callCount(operation: string, accountId: string): Promise<number> {
    return Promise.resolve(this.calls.get(`${operation}:${accountId}`) ?? 0);
  }

  setOnce(flag: string): Promise<boolean> {
    if (this.flags.has(flag)) {
      return Promise.resolve(false);
    }
    this.flags.add(flag);
    return Promise.resolve(true);
  }

  save(post: MockPost): Promise<void> {
    this.posts.set(post.externalPostId, post);
    return Promise.resolve();
  }

  find(externalPostId: string): Promise<MockPost | undefined> {
    return Promise.resolve(this.posts.get(externalPostId));
  }

  postsOf(accountId: string): Promise<MockPost[]> {
    return Promise.resolve([...this.posts.values()].filter((post) => post.accountId === accountId));
  }
}

const postSchema = z.object({
  externalPostId: z.string(),
  accountId: z.string(),
  text: z.string(),
  contentHash: z.string(),
  publishedAt: z.iso.datetime().transform((value) => new Date(value)),
  deletedAt: z.iso
    .datetime()
    .nullable()
    .transform((value) => (value === null ? null : new Date(value))),
});

const parsePost = (value: string | null): MockPost | undefined => {
  if (value === null) {
    return undefined;
  }
  const parsed = postSchema.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : undefined;
};

/** The store in Redis, under a prefix of its own (mock: by default). */
export class RedisMockPlatformStore implements MockPlatformStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'mock:',
  ) {}

  async countCall(operation: string, accountId: string): Promise<void> {
    await this.redis.hincrby(`${this.prefix}calls`, `${operation}:${accountId}`, 1);
  }

  async callCount(operation: string, accountId: string): Promise<number> {
    return Number((await this.redis.hget(`${this.prefix}calls`, `${operation}:${accountId}`)) ?? 0);
  }

  async setOnce(flag: string): Promise<boolean> {
    return (await this.redis.set(`${this.prefix}flag:${flag}`, '1', 'NX')) === 'OK';
  }

  async save(post: MockPost): Promise<void> {
    await this.redis
      .multi()
      .hset(`${this.prefix}posts`, post.externalPostId, JSON.stringify(post))
      .sadd(`${this.prefix}account-posts:${post.accountId}`, post.externalPostId)
      .exec();
  }

  async find(externalPostId: string): Promise<MockPost | undefined> {
    return parsePost(await this.redis.hget(`${this.prefix}posts`, externalPostId));
  }

  async postsOf(accountId: string): Promise<MockPost[]> {
    const ids = await this.redis.smembers(`${this.prefix}account-posts:${accountId}`);
    if (ids.length === 0) {
      return [];
    }
    const values = await this.redis.hmget(`${this.prefix}posts`, ...ids);
    return values.flatMap((value) => {
      const post = parsePost(value);
      return post ? [post] : [];
    });
  }
}
