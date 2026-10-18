import { createHash } from 'node:crypto';

import type { Logger } from '@nestjs/common';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import type Redis from 'ioredis';

// What the auth flows need beyond Better Auth (guide step 8.4, ADR 0039). Better Auth limits the
// requests per client address and path; these hooks add:
// - a limit of failed sign-ins per account, so a pool of addresses cannot try passwords on it,
// - a limit of failed password checks per user on the endpoints that take the password of a
//   session, so a stolen session cannot guess the password and take over the second factor.

/** Failed sign-ins per account and window, from whatever addresses they come. */
export const SIGN_IN_FAILURES_PER_ACCOUNT = 10;
/** Failed password checks per user and window on the endpoints that take the password again. */
export const PASSWORD_FAILURES_PER_USER = 5;
export const AUTH_FAILURE_WINDOW_SECONDS = 15 * 60;

/** The endpoints that check the password of the signed-in user. */
const PASSWORD_PATHS = new Set([
  '/change-password',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
]);

// INCR with an expiry set on the first hit, as in the password check of the API.
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

/** A short digest of an address: enough to see attacks on one account, not the address. */
export const accountDigest = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);

export interface AuthHookDependencies {
  redis: Redis;
  logger: Logger;
}

export function createAuthHooks({ redis, logger }: AuthHookDependencies) {
  // A counter lives for the window from its first failure on, so failures never split across
  // two windows.
  const accountKey = (email: string): string => `auth:sign-in-failures:${accountDigest(email)}`;
  const userKey = (userId: string): string => `auth:password-failures:${userId}`;
  const count = async (key: string): Promise<number> => Number((await redis.get(key)) ?? 0);
  const increment = async (key: string): Promise<void> => {
    await redis.eval(INCREMENT, 1, key, String(AUTH_FAILURE_WINDOW_SECONDS));
  };
  const tooMany = (): APIError =>
    APIError.from('TOO_MANY_REQUESTS', {
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many failed attempts; wait before trying again.',
    });
  const emailOf = (body: unknown): string | null => {
    const email = (body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' && email.length > 0 ? email : null;
  };

  const before = createAuthMiddleware(async (ctx) => {
    if (ctx.path === '/sign-in/email') {
      const email = emailOf(ctx.body);
      if (email && (await count(accountKey(email))) >= SIGN_IN_FAILURES_PER_ACCOUNT) {
        logger.warn({ path: ctx.path, outcome: 'blocked', account: accountDigest(email) }, 'auth.event');
        throw tooMany();
      }
      return;
    }
    if (PASSWORD_PATHS.has(ctx.path)) {
      const session = await getSessionFromCtx(ctx);
      if (session && (await count(userKey(session.user.id))) >= PASSWORD_FAILURES_PER_USER) {
        logger.warn({ path: ctx.path, outcome: 'blocked', userId: session.user.id }, 'auth.event');
        throw tooMany();
      }
      return;
    }
    return;
  });

  const after = createAuthMiddleware(async (ctx) => {
    const isSignIn = ctx.path === '/sign-in/email';
    const isPasswordPath = PASSWORD_PATHS.has(ctx.path);
    if (!isSignIn && !isPasswordPath) {
      return;
    }
    const returned: unknown = ctx.context.returned;
    const failure = isAPIError(returned) ? returned : null;
    const code = failure ? (failure.body?.code ?? failure.status) : null;
    // The session of a sign-in, or the one the before hook or the endpoint read.
    const signedIn = ctx.context.newSession?.user ?? ctx.context.session?.user ?? null;
    const userId = signedIn?.id ?? null;
    const email = emailOf(ctx.body);

    if (isSignIn && email) {
      if (failure?.statusCode === 401) {
        await increment(accountKey(email));
      } else if (!failure) {
        await redis.del(accountKey(email));
      }
    }
    if (isPasswordPath && userId && failure && code === 'INVALID_PASSWORD') {
      await increment(userKey(userId));
    }
  });

  return { before, after };
}
