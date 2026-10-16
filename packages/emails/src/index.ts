// Email templates in German and English and the SMTP adapter of the MailPort.

export {
  deliverEmail,
  emailTemplateSchema,
  renderEmail,
  type EmailTemplateInput,
  type RenderedEmail,
} from './render';
export { createSmtpMailer, type SmtpMailerOptions } from './smtp-mailer';
