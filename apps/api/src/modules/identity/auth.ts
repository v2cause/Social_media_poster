import type { Logger } from '@nestjs/common';
import {
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  localeSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  timezoneSchema,
} from '@smp/contracts';
import type { PrismaClient } from '@smp/db';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { isAPIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import type Redis from 'ioredis';
import { uuidv7 } from 'uuidv7';

import type { ApiEnv } from '../../config/api-env';
import { createAuthHooks } from './auth-hooks';
import type { AuthMailer } from './auth-mailer';
import { authSecretConfig } from './auth-secrets';
import { createBreachCheck, noBreachCheck } from './breached-passwords';
import { PasswordPolicy } from './password-policy';

export const AUTH = Symbol('AUTH');

export interface AuthDependencies {
  env: ApiEnv;
  /** app_user without tenant extension: the auth tables are global and have no RLS. */
  prisma: PrismaClient;
  mailer: AuthMailer;
  /** The limits of failed attempts per account and per user (guide step 8.4). */
  redis: Redis;
  logger: Logger;
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Cookies over https carry the prefix __Host- (ASVS 3.3.3): Secure, Path=/ and no Domain, so no
 * other host of the domain can set or replace them. Better Auth would put __Secure- in front of
 * any name it makes secure, so it gets the prefix as a name and the attribute by default.
 */
export function authCookieOptions(env: Pick<ApiEnv, 'NODE_ENV' | 'BETTER_AUTH_URL'>): {
  cookiePrefix: string;
  useSecureCookies: false;
  defaultCookieAttributes?: { secure: true };
} {
  const secure = env.NODE_ENV === 'production' || env.BETTER_AUTH_URL.startsWith('https://');
  return secure
    ? { cookiePrefix: '__Host-smp', useSecureCookies: false, defaultCookieAttributes: { secure: true } }
    : { cookiePrefix: 'smp', useSecureCookies: false };
}

/** Better Auth under /api/auth (guide steps 1.4 and 8.4, ADR 0006 and 0039). */
export function createAuth({ env, prisma, mailer, redis, logger }: AuthDependencies) {
  // Mails go out in the background: awaiting them would make response times reveal whether an
  // address exists. Failures are logged without the address.
  const dispatch = (event: string, task: Promise<void>): void => {
    void task.catch((error: unknown) => {
      logger.error({ err: error }, event);
    });
  };

  // New passwords go to the breach check where PWNED_PASSWORDS_API_URL names one (production).
  const passwordPolicy = new PasswordPolicy(
    env.PWNED_PASSWORDS_API_URL
      ? createBreachCheck({ baseUrl: env.PWNED_PASSWORDS_API_URL, logger })
      : noBreachCheck,
  );

  return betterAuth({
    appName: 'Social Media Poster',
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    // After a rotation the versioned keys; BETTER_AUTH_SECRET then opens the older payloads.
    ...(authSecretConfig(env) ? { secrets: env.BETTER_AUTH_SECRETS } : {}),
    trustedOrigins: [env.APP_URL],
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    emailAndPassword: {
      enabled: true,
      // No session before the address is verified, so organizations need a verified email.
      requireEmailVerification: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        dispatch('auth.reset_mail_failed', mailer.sendResetPassword(user, url));
        return Promise.resolve();
      },
      // A sign-up with a known address answers like a new one; the owner of the address hears of it.
      onExistingUserSignUp: async ({ user }) => {
        dispatch(
          'auth.existing_account_mail_failed',
          mailer.sendExistingAccountNotice(user, `${env.APP_URL.replace(/\/$/, '')}/login`),
        );
        return Promise.resolve();
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // The link only verifies; signing in needs the password. Otherwise whoever registered an
      // address first, with a password of their own, would hold the account its owner verifies.
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        dispatch('auth.verification_mail_failed', mailer.sendVerificationEmail(user, url));
        return Promise.resolve();
      },
    },
    user: {
      additionalFields: {
        locale: { type: 'string', defaultValue: DEFAULT_LOCALE, validator: { input: localeSchema } },
        timezone: { type: 'string', defaultValue: DEFAULT_TIMEZONE, validator: { input: timezoneSchema } },
        // Only platform operators set this flag, never the user (input: false).
        isPlatformAdmin: { type: 'boolean', defaultValue: false, input: false },
      },
    },
    // At most seven days after the sign-in, however often the session is used (ASVS 7.3.2).
    session: { expiresIn: 7 * DAY_SECONDS, disableSessionRefresh: true },
    // Reset tokens are stored as SHA-256 only, so a read of the table cannot reset passwords.
    verification: { storeIdentifier: 'hashed' },
    // The API checks the password itself (PasswordCheck, with a limit per user); browsers may not.
    disabledPaths: ['/verify-password'],
    hooks: createAuthHooks({ redis, logger, passwordPolicy }),
    rateLimit: {
      // Better Auth keeps it off in development; tests check it.
      enabled: env.NODE_ENV !== 'development',
      storage: 'database',
      window: 60,
      max: 100,
    },
    advanced: {
      ...authCookieOptions(env),
      // The reverse proxy overwrites X-Real-IP with the peer address (Caddyfile). A forwarded
      // chain is not trusted, because its first entry is set by the client.
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
      database: { generateId: () => uuidv7() },
    },
    plugins: [twoFactor({ issuer: 'Social Media Poster' })],
    // Refusals that the hooks throw (429, 400) reach the router, which would print them to the
    // console at level error; the hooks log their own events. Only failures of Better Auth itself
    // are errors.
    onAPIError: {
      onError: (error) => {
        if (!isAPIError(error) || error.statusCode >= 500) {
          logger.error({ err: error }, 'auth.error');
        }
      },
    },
    logger: {
      level: 'warn',
      // Only the message: the extra arguments can hold request data.
      log: (level, message) => {
        if (level === 'error') {
          logger.error({ message }, 'auth.error');
        } else {
          logger.warn({ message }, 'auth.warning');
        }
      },
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
