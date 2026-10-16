import { Inject, Injectable } from '@nestjs/common';
import { toLocale } from '@smp/contracts';
import type { MailPort } from '@smp/core';
import { renderEmail } from '@smp/emails';

import { MAIL_PORT } from '../../infrastructure/clients.module';

/** The fields of a Better Auth user the emails need. */
export interface AuthMailRecipient {
  email: string;
  name: string;
  locale?: unknown;
}

/** Sends the emails of the auth flows in the user's language. */
@Injectable()
export class AuthMailer {
  constructor(@Inject(MAIL_PORT) private readonly mail: MailPort) {}

  sendVerificationEmail(user: AuthMailRecipient, url: string): Promise<void> {
    return this.send('verify-email', user, url);
  }

  sendResetPassword(user: AuthMailRecipient, url: string): Promise<void> {
    return this.send('reset-password', user, url);
  }

  private async send(
    template: 'verify-email' | 'reset-password',
    user: AuthMailRecipient,
    url: string,
  ): Promise<void> {
    const email = await renderEmail({ template, locale: toLocale(user.locale), name: user.name, url });
    await this.mail.send({ to: user.email, ...email });
  }
}
