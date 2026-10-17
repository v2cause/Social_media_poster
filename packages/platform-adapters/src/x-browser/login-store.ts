import {
  BROWSER_LOGIN_FAILURES,
  BROWSER_LOGIN_STATUSES,
  BROWSER_LOGIN_TTL_MS,
  type BrowserLogin,
  type BrowserLoginStore,
} from '@smp/core';
import { XB_KEYS } from '@smp/x-browser';
import type { ChainableCommander, default as Redis } from 'ioredis';
import { z } from 'zod';

// The logins of X in Redis (guide step 6.4): a hash per login, kept a quarter of an hour past its
// end so its outcome can still be read, outside the keys the browser worker reaches. Its codes go
// to the list xb:login:{id}:input, which the browser worker pops; the starts count in a key per
// workspace and hour. A step changes in one script, so two reports never both move the login
// along. What comes back from Redis is checked like any other input.

/** How long a login stays readable after it ended. */
const KEPT_AFTER_END_MS = 15 * 60_000;

const loginKey = (id: string): string => `x-browser:login:${id}`;
const startsKey = (workspaceId: string, at: Date): string =>
  `x-browser:login-starts:${workspaceId}:${String(Math.floor(at.getTime() / 3_600_000))}`;

// ARGV: the number n of allowed statuses, the n statuses, then field and value pairs.
const TRANSITION = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return nil end
local count = tonumber(ARGV[1])
local allowed = false
for i = 2, count + 1 do
  if ARGV[i] == status then allowed = true end
end
if not allowed then return nil end
for i = count + 2, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end
return redis.call('HGETALL', KEYS[1])`;

// INCR with an expiry set on the first hit: one round trip, no key without expiry.
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

const loginSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  status: z.enum(BROWSER_LOGIN_STATUSES),
  failure: z.enum(BROWSER_LOGIN_FAILURES).optional(),
  accountId: z.string().optional(),
  reconnectAccountId: z.string().optional(),
  locale: z.enum(['de', 'en']),
  startedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

/** Runs a MULTI; ioredis reports a command that failed inside it in the result, not as an error. */
async function inOne(multi: ChainableCommander): Promise<void> {
  const results = await multi.exec();
  const failed = results?.find(([error]) => error !== null);
  if (!results || failed) {
    throw failed?.[0] ?? new Error('The transaction was discarded.');
  }
}

/** A hash as HGETALL gives it, or the flat list of a script; anything that does not parse is missing. */
function loginOf(fields: Record<string, string> | readonly string[] | null): BrowserLogin | null {
  if (fields === null) {
    return null;
  }
  const record: Record<string, string> = {};
  if (Array.isArray(fields)) {
    for (let index = 0; index + 1 < fields.length; index += 2) {
      record[String(fields[index])] = String(fields[index + 1]);
    }
  } else {
    Object.assign(record, fields);
  }
  const parsed = loginSchema.safeParse(record);
  if (!parsed.success) {
    return null;
  }
  const login = parsed.data;
  return {
    id: login.id,
    organizationId: login.organizationId,
    workspaceId: login.workspaceId,
    userId: login.userId,
    status: login.status,
    failure: login.failure ?? null,
    accountId: login.accountId ?? null,
    reconnectAccountId: login.reconnectAccountId ?? null,
    locale: login.locale,
    startedAt: new Date(login.startedAt),
    expiresAt: new Date(login.expiresAt),
  };
}

export class RedisBrowserLoginStore implements BrowserLoginStore {
  constructor(private readonly redis: Redis) {}

  async create(login: BrowserLogin): Promise<void> {
    const key = loginKey(login.id);
    const fields: Record<string, string> = {
      id: login.id,
      organizationId: login.organizationId,
      workspaceId: login.workspaceId,
      userId: login.userId,
      status: login.status,
      locale: login.locale,
      startedAt: login.startedAt.toISOString(),
      expiresAt: login.expiresAt.toISOString(),
    };
    for (const [field, value] of [
      ['failure', login.failure],
      ['accountId', login.accountId],
      ['reconnectAccountId', login.reconnectAccountId],
    ] as const) {
      if (value !== null) {
        fields[field] = value;
      }
    }
    await inOne(
      this.redis
        .multi()
        .hset(key, fields)
        .pexpireat(key, login.expiresAt.getTime() + KEPT_AFTER_END_MS),
    );
  }

  async find(id: string): Promise<BrowserLogin | null> {
    const fields = await this.redis.hgetall(loginKey(id));
    return Object.keys(fields).length === 0 ? null : loginOf(fields);
  }

  async transition(
    id: string,
    from: Parameters<BrowserLoginStore['transition']>[1],
    change: Parameters<BrowserLoginStore['transition']>[2],
  ): Promise<BrowserLogin | null> {
    const pairs = [
      'status',
      change.status,
      ...(change.failure === undefined ? [] : ['failure', change.failure]),
      ...(change.accountId === undefined ? [] : ['accountId', change.accountId]),
    ];
    const result = (await this.redis.eval(
      TRANSITION,
      1,
      loginKey(id),
      String(from.length),
      ...from,
      ...pairs,
    )) as string[] | null;
    return loginOf(result);
  }

  async pushCode(id: string, sealed: Uint8Array): Promise<void> {
    const key = XB_KEYS.loginInput(id);
    await inOne(
      this.redis
        .multi()
        .rpush(key, Buffer.from(sealed).toString('base64'))
        .pexpire(key, BROWSER_LOGIN_TTL_MS),
    );
  }

  async countStart(workspaceId: string, at: Date): Promise<number> {
    return Number(await this.redis.eval(INCREMENT, 1, startsKey(workspaceId, at), '3600'));
  }
}
