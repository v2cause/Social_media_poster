import type { MailMessage, MailPort } from '@smp/core';
import { createTransport } from 'nodemailer';
import { z } from 'zod';

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

const code = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,31}$/)
  .optional()
  .catch(undefined);

/** What tells the cause of a nodemailer error. Its message, reply and recipients name addresses. */
const failureOf = z.object({
  /** Nodemailer's code, for example EENVELOPE, ECONNECTION or ETLS */
  code,
  /** The code of the system error behind it, for example ECONNREFUSED behind ESOCKET */
  originalCode: code,
  /** The SMTP command in flight, for example RCPT TO */
  command: z
    .string()
    .regex(/^[A-Z][A-Z0-9 -]{0,31}$/)
    .optional()
    .catch(undefined),
  /** The SMTP reply code, for example 550 */
  responseCode: z.number().int().min(100).max(599).optional().catch(undefined),
});

type SmtpFailure = z.output<typeof failureOf>;

/**
 * A mail the SMTP server did not take (guide step 8.4). Nodemailer writes the reply of the server,
 * which names a rejected address, into its message and attaches the rejected recipients, and a
 * failed job keeps its message and stack (ADR 0012). This error keeps only the codes.
 */
export class SmtpDeliveryError extends Error {
  readonly code: string | undefined;
  readonly originalCode: string | undefined;
  readonly command: string | undefined;
  readonly responseCode: number | undefined;

  constructor(failure: SmtpFailure) {
    const parts = [
      failure.code,
      failure.originalCode,
      failure.command,
      failure.responseCode === undefined ? undefined : String(failure.responseCode),
    ].filter((part) => part !== undefined);
    super(parts.length === 0 ? 'SMTP delivery failed' : `SMTP delivery failed: ${parts.join(', ')}`);
    this.name = 'SmtpDeliveryError';
    this.code = failure.code;
    this.originalCode = failure.originalCode;
    this.command = failure.command;
    this.responseCode = failure.responseCode;
  }
}

/** MailPort over SMTP (nodemailer). Locally the messages land in Mailpit. */
export function createSmtpMailer(options: SmtpMailerOptions): MailPort & { close(): void } {
  const transport = createTransport(
    options.requireTls === true ? { url: options.url, requireTLS: true } : options.url,
  );
  return {
    async send(message: MailMessage): Promise<void> {
      try {
        await transport.sendMail({
          from: options.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        });
      } catch (error) {
        // Not the original as cause: loggers and the queue would show its message.
        const parsed = failureOf.safeParse(error);
        throw new SmtpDeliveryError(parsed.success ? parsed.data : {});
      }
    },
    close(): void {
      transport.close();
    },
  };
}
