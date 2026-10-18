import { Inject, Injectable, Logger } from '@nestjs/common';
import { toLocale } from '@smp/contracts';
import { NotificationProducer } from '@smp/queue';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../../infrastructure/clients.module';
import { accountDigest } from './auth-hooks';

/** The fields of a Better Auth user the emails need. */
export interface AuthMailRecipient {
  email: string;
  name: string;
  locale?: unknown;
}

/** Emails of the auth flows per address and hour; more are dropped (guide step 8.4). */
export const AUTH_MAILS_PER_ADDRESS_AND_HOUR = 5;
const HOUR_SECONDS = 60 * 60;

// INCR with an expiry set on the first hit, as in the password check of the API.
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

/**
 * Queues the emails of the auth flows in the user's language; the notify worker sends them. Sign-up,
 * resend and reset can be asked for any address, so each address gets at most a few of these
 * emails an hour; the requests answer the same either way, so nobody learns of the limit.
 */
@Injectable()
export class AuthMailer {
  private readonly logger = new Logger(AuthMailer.name);

  constructor(
    private readonly notifications: NotificationProducer,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  sendVerificationEmail(user: AuthMailRecipient, url: string): Promise<void> {
    return this.send(user, 'verify-email', url);
  }

  sendResetPassword(user: AuthMailRecipient, url: string): Promise<void> {
    return this.send(user, 'reset-password', url);
  }

  /** Someone signed up with the address of this account; the link leads to the sign-in. */
  sendExistingAccountNotice(user: AuthMailRecipient, url: string): Promise<void> {
    return this.send(user, 'existing-account', url);
  }

  private async send(
    user: AuthMailRecipient,
    template: 'verify-email' | 'reset-password' | 'existing-account',
    url: string,
  ): Promise<void> {
    const digest = accountDigest(user.email);
    // The counter lives for an hour from the first email on.
    const sent = Number(await this.redis.eval(INCREMENT, 1, `auth-mail:${digest}`, String(HOUR_SECONDS)));
    if (sent > AUTH_MAILS_PER_ADDRESS_AND_HOUR) {
      this.logger.warn({ template, account: digest }, 'auth.mail_dropped');
      return;
    }
    await this.notifications.dispatchEmail(user.email, {
      template,
      locale: toLocale(user.locale),
      name: user.name,
      url,
    });
  }
}
