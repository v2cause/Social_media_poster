import { render } from '@react-email/render';
import { localeSchema, roleSchema } from '@smp/contracts';
import type { MailPort } from '@smp/core';
import { z } from 'zod';

import { format, messages } from './messages';
import { ActionEmail, type ActionEmailText } from './templates/action-email';

const httpUrl = z.url({ protocol: /^https?$/ });
const name = z.string().trim().max(200).optional();

/** Every email the platform sends, validated before rendering (also when it arrives as a job). */
export const emailTemplateSchema = z.discriminatedUnion('template', [
  z.object({ template: z.literal('verify-email'), locale: localeSchema, name, url: httpUrl }),
  z.object({ template: z.literal('reset-password'), locale: localeSchema, name, url: httpUrl }),
  z.object({
    template: z.literal('invitation'),
    locale: localeSchema,
    url: httpUrl,
    organizationName: z.string().trim().min(1).max(200),
    inviterName: z.string().trim().min(1).max(200),
    role: roleSchema,
  }),
]);

export type EmailTemplateInput = z.input<typeof emailTemplateSchema>;
type EmailTemplate = z.output<typeof emailTemplateSchema>;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The texts of one email in the recipient's language. Values are text; React escapes them. */
function compose(email: EmailTemplate): ActionEmailText {
  const locale = messages[email.locale];
  const { common } = locale;
  const base = {
    linkFallback: common.linkFallback,
    footer: common.footer,
  };
  switch (email.template) {
    case 'verify-email':
    case 'reset-password': {
      const text = email.template === 'verify-email' ? locale.verifyEmail : locale.resetPassword;
      const greeting = email.name
        ? format(common.greeting, { name: email.name })
        : common.greetingWithoutName;
      return { ...base, ...text, greeting };
    }
    case 'invitation': {
      const values = {
        organization: email.organizationName,
        inviter: email.inviterName,
        role: locale.roles[email.role],
      };
      const text = locale.invitation;
      return {
        ...base,
        subject: format(text.subject, values),
        preview: format(text.preview, values),
        greeting: common.greetingWithoutName,
        intro: format(text.intro, values),
        action: text.action,
        expiry: text.expiry,
        ignore: format(text.ignore, values),
      };
    }
  }
}

/** Renders the HTML and the plain-text part of an email in the recipient's language. */
export async function renderEmail(input: EmailTemplateInput): Promise<RenderedEmail> {
  const email = emailTemplateSchema.parse(input);
  const text = compose(email);
  const element = <ActionEmail locale={email.locale} url={email.url} text={text} />;
  const [html, plain] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject: text.subject, html, text: plain };
}

/** Renders an email and hands it to the mail port: what the notify worker does per job. */
export async function deliverEmail(mail: MailPort, to: string, input: EmailTemplateInput): Promise<void> {
  const rendered = await renderEmail(input);
  await mail.send({ to, ...rendered });
}
