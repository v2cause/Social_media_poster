import { render } from '@react-email/render';
import { localeSchema } from '@smp/contracts';
import { z } from 'zod';

import { messages } from './messages';
import { ActionEmail } from './templates/action-email';

const httpUrl = z.url({ protocol: /^https?$/ });
const name = z.string().trim().max(200).optional();

/** Every email the platform sends, validated before rendering (also when it arrives as a job). */
export const emailTemplateSchema = z.discriminatedUnion('template', [
  z.object({ template: z.literal('verify-email'), locale: localeSchema, name, url: httpUrl }),
  z.object({ template: z.literal('reset-password'), locale: localeSchema, name, url: httpUrl }),
]);

export type EmailTemplateInput = z.input<typeof emailTemplateSchema>;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const KIND = { 'verify-email': 'verifyEmail', 'reset-password': 'resetPassword' } as const;

/** Renders the HTML and the plain-text part of an email in the recipient's language. */
export async function renderEmail(input: EmailTemplateInput): Promise<RenderedEmail> {
  const email = emailTemplateSchema.parse(input);
  const kind = KIND[email.template];
  const element = <ActionEmail locale={email.locale} kind={kind} name={email.name} url={email.url} />;
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject: messages[email.locale][kind].subject, html, text };
}
