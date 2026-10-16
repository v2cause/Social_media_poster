// Email templates in German and English and the SMTP adapter of the MailPort.

export {
  deliverEmail,
  emailTemplateSchema,
  NAMED_ACCOUNTS,
  renderEmail,
  type EmailTemplateInput,
  type RenderedEmail,
} from './render';
export { notificationEmailOf } from './notification-email';
export { createSmtpMailer, type SmtpMailerOptions } from './smtp-mailer';
