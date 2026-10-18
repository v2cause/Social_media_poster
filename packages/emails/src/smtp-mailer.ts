import type { MailMessage, MailPort } from '@smp/core';
import { createTransport } from 'nodemailer';

export interface SmtpMailerOptions {
  /** smtp://host:port or smtps://user:password@host:port */
  url: string;
  /** Sender address, for example noreply@example.com */
  from: string;
  /**
   * Never send in plain text (production, guide step 8.4): smtps:// starts with TLS, and smtp://
   * must upgrade with STARTTLS or the mail fails. The certificate is checked either way.
   */
  requireTls?: boolean;
}

/** MailPort over SMTP (nodemailer). Locally the messages land in Mailpit. */
export function createSmtpMailer(options: SmtpMailerOptions): MailPort & { close(): void } {
  const transport = createTransport(
    options.requireTls === true ? { url: options.url, requireTLS: true } : options.url,
  );
  return {
    async send(message: MailMessage): Promise<void> {
      await transport.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    },
    close(): void {
      transport.close();
    },
  };
}
