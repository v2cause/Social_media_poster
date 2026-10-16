import { Injectable } from '@nestjs/common';
import { toLocale } from '@smp/contracts';
import { NotificationProducer } from '@smp/queue';

/** The fields of a Better Auth user the emails need. */
export interface AuthMailRecipient {
  email: string;
  name: string;
  locale?: unknown;
}

/** Queues the emails of the auth flows in the user's language; the notify worker sends them. */
@Injectable()
export class AuthMailer {
  constructor(private readonly notifications: NotificationProducer) {}

  sendVerificationEmail(user: AuthMailRecipient, url: string): Promise<void> {
    return this.notifications.dispatchEmail(user.email, {
      template: 'verify-email',
      locale: toLocale(user.locale),
      name: user.name,
      url,
    });
  }

  sendResetPassword(user: AuthMailRecipient, url: string): Promise<void> {
    return this.notifications.dispatchEmail(user.email, {
      template: 'reset-password',
      locale: toLocale(user.locale),
      name: user.name,
      url,
    });
  }
}
