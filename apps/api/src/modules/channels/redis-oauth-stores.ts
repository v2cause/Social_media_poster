import {
  CONNECTION_METHODS,
  SOCIAL_ACCOUNT_TYPES,
  type Clock,
  type OAuthState,
  type OAuthStateStore,
  type PendingConnection,
  type PendingConnectionStore,
} from '@smp/core';
import { PLATFORMS } from '@smp/platform-rules';
import type Redis from 'ioredis';
import { z } from 'zod';

// The state of an authorization and the parked consents in Redis (guide step 4.5). A state is
// read and deleted in one command (GETDEL), so it works once. What comes back from Redis is
// checked like any other input; a record that does not parse counts as missing.

const stateKey = (state: string): string => `oauth:state:${state}`;
const pendingKey = (id: string): string => `oauth:pending:${id}`;

const stateSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  workspaceId: z.string(),
  workspaceSlug: z.string(),
  platform: z.enum(PLATFORMS),
  method: z.enum(CONNECTION_METHODS),
  redirectUri: z.string(),
  codeVerifier: z.string().nullable(),
  reconnectAccountId: z.string().nullable(),
}) satisfies z.ZodType<OAuthState>;

const pendingSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  workspaceId: z.string(),
  platform: z.enum(PLATFORMS),
  method: z.enum(CONNECTION_METHODS),
  externalUserId: z.string(),
  displayName: z.string(),
  requestedScopes: z.array(z.string()),
  grantedScopes: z.array(z.string()),
  accounts: z.array(
    z.object({
      externalId: z.string(),
      type: z.enum(SOCIAL_ACCOUNT_TYPES),
      name: z.string(),
      handle: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    }),
  ),
  /** The sealed envelope as base64. */
  sealedSecrets: z.base64(),
  reconnectAccountId: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});

function parse<T>(schema: z.ZodType<T>, value: string | null): T | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class RedisOAuthStateStore implements OAuthStateStore {
  constructor(private readonly redis: Redis) {}

  async save(state: string, data: OAuthState, ttlMs: number): Promise<void> {
    await this.redis.set(stateKey(state), JSON.stringify(data), 'PX', ttlMs);
  }

  async take(state: string): Promise<OAuthState | null> {
    return parse(stateSchema, await this.redis.getdel(stateKey(state)));
  }
}

export class RedisPendingConnectionStore implements PendingConnectionStore {
  constructor(
    private readonly redis: Redis,
    private readonly clock: Clock,
  ) {}

  async save(pending: PendingConnection): Promise<void> {
    const ttlMs = pending.expiresAt.getTime() - this.clock.now().getTime();
    if (ttlMs <= 0) {
      return;
    }
    const record: z.input<typeof pendingSchema> = {
      ...pending,
      sealedSecrets: Buffer.from(pending.sealedSecrets).toString('base64'),
      expiresAt: pending.expiresAt.toISOString(),
    };
    await this.redis.set(pendingKey(pending.id), JSON.stringify(record), 'PX', ttlMs);
  }

  async find(id: string): Promise<PendingConnection | null> {
    const record = parse(pendingSchema, await this.redis.get(pendingKey(id)));
    return record
      ? {
          ...record,
          sealedSecrets: new Uint8Array(Buffer.from(record.sealedSecrets, 'base64')),
          expiresAt: new Date(record.expiresAt),
        }
      : null;
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(pendingKey(id));
  }
}
