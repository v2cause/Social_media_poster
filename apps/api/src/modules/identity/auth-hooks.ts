import { createHash } from 'node:crypto';

import type { Logger } from '@nestjs/common';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@smp/contracts';
import type { GenericEndpointContext } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import type Redis from 'ioredis';

import type { PasswordContext, PasswordPolicy, PasswordProblem } from './password-policy';

// What the auth flows need beyond Better Auth (guide step 8.4, ADR 0039). Better Auth limits the
// requests per client address and path; these hooks add:
// - a limit of failed sign-ins per account, so a pool of addresses cannot try passwords on it,
// - a limit of failed password checks per user on the endpoints that take the password of a
//   session, so a stolen session cannot guess the password and take over the second factor,
// - no "trust this device": every sign-in asks for the second factor,
// - every TOTP code works once per user, also across two sign-ins within its time window,
// - the password policy for every new password (PasswordPolicy),
// - a security event in the log for sign-ins, sign-ups, sign-outs, resets and every change of a
//   factor or a session. Events name the user or a digest of the address, never the address.

/** Failed sign-ins per account and window, from whatever addresses they come. */
export const SIGN_IN_FAILURES_PER_ACCOUNT = 10;
/** Failed password checks per user and window on the endpoints that take the password again. */
export const PASSWORD_FAILURES_PER_USER = 5;
export const AUTH_FAILURE_WINDOW_SECONDS = 15 * 60;
/**
 * How long a TOTP code counts as used: Better Auth takes the code of the step before and after
 * the current one, so a code works for up to 90 seconds.
 */
export const TOTP_USED_SECONDS = 120;

/** The endpoints that check the password of the signed-in user. */
const PASSWORD_PATHS = new Set([
  '/change-password',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
]);
const SECOND_FACTOR_PATHS = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);
/** The endpoints that set a new password, with the field of the body that carries it. */
const NEW_PASSWORD_FIELDS = new Map([
  ['/sign-up/email', 'password'],
  ['/change-password', 'newPassword'],
  ['/reset-password', 'newPassword'],
]);
const PASSWORD_PROBLEMS: Record<PasswordProblem, string> = {
  PASSWORD_TOO_COMMON: 'The password is one of the most common passwords.',
  PASSWORD_CONTAINS_CONTEXT:
    'The password contains the name of the product, the address or the name of the user.',
  PASSWORD_COMPROMISED: 'The password appeared in a known data breach.',
};
/** Further endpoints whose outcome is a security event. */
const EVENT_PATHS = new Set([
  '/sign-up/email',
  '/sign-out',
  '/verify-email',
  '/send-verification-email',
  '/request-password-reset',
  '/reset-password',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
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
  passwordPolicy: PasswordPolicy;
}

export function createAuthHooks({ redis, logger, passwordPolicy }: AuthHookDependencies) {
  // A counter lives for the window from its first failure on, so failures never split across
  // two windows.
  const accountKey = (email: string): string => `auth:sign-in-failures:${accountDigest(email)}`;
  const userKey = (userId: string): string => `auth:password-failures:${userId}`;
  const totpKey = (userId: string, code: string): string => `auth:totp-used:${userId}:${code}`;
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
  const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

  /** Whose new password it is: from the sign-up, the session or the user of the reset token. */
  const passwordContext = async (
    ctx: GenericEndpointContext,
    body: Record<string, unknown>,
  ): Promise<PasswordContext> => {
    if (ctx.path === '/sign-up/email') {
      return { email: textOf(body['email']), name: textOf(body['name']) };
    }
    if (ctx.path === '/change-password') {
      const session = await getSessionFromCtx(ctx);
      return { email: session?.user.email ?? null, name: session?.user.name ?? null };
    }
    const token = textOf(body['token']);
    const adapter = ctx.context.internalAdapter;
    const verification = token ? await adapter.findVerificationValue(`reset-password:${token}`) : null;
    const user = verification ? await adapter.findUserById(verification.value) : null;
    return { email: user?.email ?? null, name: user?.name ?? null };
  };

  /** The user of a second-factor step: of the session, or during a sign-in of its cookie. */
  const userOfSecondFactor = async (ctx: GenericEndpointContext): Promise<string | null> => {
    const session = await getSessionFromCtx(ctx);
    if (session) {
      return session.user.id;
    }
    const cookie = ctx.context.createAuthCookie('two_factor');
    const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    const verification = identifier
      ? await ctx.context.internalAdapter.findVerificationValue(identifier)
      : null;
    return verification?.value ?? null;
  };

  /**
   * Marks the code as used before Better Auth checks it, so that two requests with one code
   * cannot both pass. A wrong code is marked as well, which costs nothing.
   */
  const refuseUsedCode = async (
    ctx: GenericEndpointContext,
    body: Record<string, unknown>,
  ): Promise<void> => {
    const code = textOf(body['code']);
    const userId = code ? await userOfSecondFactor(ctx) : null;
    if (!code || !userId) {
      return;
    }
    const fresh = await redis.set(totpKey(userId, code), '1', 'EX', TOTP_USED_SECONDS, 'NX');
    if (fresh === null) {
      logger.warn({ path: ctx.path, outcome: 'code_reused', userId }, 'auth.event');
      throw APIError.from('UNAUTHORIZED', {
        code: 'CODE_ALREADY_USED',
        message: 'The code was used already; wait for the next one.',
      });
    }
  };

  const refuseWeakPassword = async (ctx: GenericEndpointContext, field: string): Promise<void> => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const password = body[field];
    // Better Auth answers a missing password or one of the wrong length itself.
    if (
      typeof password !== 'string' ||
      password.length < PASSWORD_MIN_LENGTH ||
      password.length > PASSWORD_MAX_LENGTH
    ) {
      return;
    }
    const problem = await passwordPolicy.problem(password, await passwordContext(ctx, body));
    if (problem) {
      throw APIError.from('BAD_REQUEST', { code: problem, message: PASSWORD_PROBLEMS[problem] });
    }
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
    }
    const passwordField = NEW_PASSWORD_FIELDS.get(ctx.path);
    if (passwordField) {
      await refuseWeakPassword(ctx, passwordField);
      return;
    }
    if (SECOND_FACTOR_PATHS.has(ctx.path)) {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (ctx.path === '/two-factor/verify-totp') {
        await refuseUsedCode(ctx, body);
      }
      if (body['trustDevice'] === true) {
        return { context: { body: { ...body, trustDevice: false } } };
      }
    }
    return;
  });

  const after = createAuthMiddleware(async (ctx) => {
    const isSignIn = ctx.path === '/sign-in/email';
    const isPasswordPath = PASSWORD_PATHS.has(ctx.path);
    if (!isSignIn && !isPasswordPath && !SECOND_FACTOR_PATHS.has(ctx.path) && !EVENT_PATHS.has(ctx.path)) {
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

    // This hook runs before the one of the two-factor plugin, which then swaps the new session for
    // the second step. Devices are never trusted, so the second step always follows.
    const needsSecondFactor =
      isSignIn && (signedIn as { twoFactorEnabled?: boolean | null } | null)?.twoFactorEnabled === true;
    const outcome = failure ? 'failed' : needsSecondFactor ? 'second_factor_required' : 'ok';
    logger.log(
      {
        path: ctx.path,
        outcome,
        ...(code ? { code } : {}),
        ...(userId ? { userId } : {}),
        ...(email && !userId ? { account: accountDigest(email) } : {}),
        clientAddress: ctx.headers?.get('x-real-ip') ?? null,
      },
      'auth.event',
    );
  });

  return { before, after };
}
