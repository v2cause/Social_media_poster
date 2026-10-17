import { render } from '@react-email/render';
import { localeSchema, platformSchema, roleSchema, timezoneSchema } from '@smp/contracts';
import { PREVIEW_MAX_UNITS, PUBLISH_FAILURE_CODES, type MailPort } from '@smp/core';
import { z } from 'zod';

import { format, messages, type EmailMessages } from './messages';
import { ActionEmail, type ActionEmailText } from './templates/action-email';

const httpUrl = z.url({ protocol: /^https?$/ });
const name = z.string().trim().max(200).optional();

/** Accounts a notification names; the others appear as a count. */
export const NAMED_ACCOUNTS = 3;

/** What every notification of guide step 4.9 names: the platform and the accounts. */
const notification = {
  locale: localeSchema,
  name,
  url: httpUrl,
  platform: platformSchema,
  accounts: z.array(z.string().trim().min(1).max(200)).min(1).max(NAMED_ACCOUNTS),
  moreAccounts: z.number().int().nonnegative().default(0),
};
const preview = z.string().max(PREVIEW_MAX_UNITS);

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
  z.object({
    template: z.literal('token-expiring'),
    ...notification,
    expiresAt: z.iso.datetime(),
    timeZone: timezoneSchema,
  }),
  z.object({
    template: z.literal('reauth-required'),
    ...notification,
    scheduledPosts: z.number().int().nonnegative(),
  }),
  z.object({
    template: z.literal('publish-failed'),
    ...notification,
    preview,
    failureCode: z.enum(PUBLISH_FAILURE_CODES),
  }),
  z.object({ template: z.literal('needs-attention'), ...notification, preview }),
  // To the platform admins about the X browser (guide step 6.5); the link leads to the admin page.
  z.object({
    template: z.literal('x-browser-breaker'),
    locale: localeSchema,
    name,
    url: httpUrl,
    drifts: z.number().int().positive(),
    flow: z.string().trim().min(1).max(40),
    selector: z.string().trim().min(1).max(100),
    selectorsVersion: z.string().trim().min(1).max(20),
  }),
  z.object({
    template: z.literal('x-browser-canary'),
    locale: localeSchema,
    name,
    url: httpUrl,
    missing: z.array(z.string().trim().min(1).max(100)).max(20),
    selectorsVersion: z.string().trim().min(1).max(20),
  }),
  // To the owners of an organization (guide step 7.4); the links lead to its billing page.
  z.object({
    template: z.literal('billing-read-only'),
    locale: localeSchema,
    name,
    url: httpUrl,
    organizationName: z.string().trim().min(1).max(200),
    reason: z.enum(['trial', 'payment', 'ended']),
  }),
  z.object({
    template: z.literal('billing-payment-failed'),
    locale: localeSchema,
    name,
    url: httpUrl,
    organizationName: z.string().trim().min(1).max(200),
    graceEndsAt: z.iso.datetime(),
    timeZone: timezoneSchema,
  }),
  // To the owner who asked for an export (guide step 8.1); the link leads to the data page.
  z.object({
    template: z.literal('gdpr-export-ready'),
    locale: localeSchema,
    name,
    url: httpUrl,
    organizationName: z.string().trim().min(1).max(200),
    expiresAt: z.iso.datetime(),
    timeZone: timezoneSchema,
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
  const greeting =
    'name' in email && email.name
      ? format(common.greeting, { name: email.name })
      : common.greetingWithoutName;
  switch (email.template) {
    case 'verify-email':
    case 'reset-password': {
      const text = email.template === 'verify-email' ? locale.verifyEmail : locale.resetPassword;
      return {
        ...base,
        subject: text.subject,
        preview: text.preview,
        greeting,
        intro: [text.intro],
        action: text.action,
        notes: [text.expiry, text.ignore],
      };
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
        intro: [format(text.intro, values)],
        action: text.action,
        notes: [text.expiry, format(text.ignore, values)],
      };
    }
    case 'token-expiring': {
      const values = {
        ...namesOf(email, locale),
        date: new Intl.DateTimeFormat(email.locale, { dateStyle: 'long', timeZone: email.timeZone }).format(
          new Date(email.expiresAt),
        ),
      };
      const text = locale.tokenExpiring;
      return {
        ...base,
        subject: format(text.subject, values),
        preview: text.preview,
        greeting,
        intro: [format(text.intro, values)],
        action: text.action,
        notes: [text.note, common.settingsHint],
      };
    }
    case 'reauth-required': {
      const values = { ...namesOf(email, locale), count: String(email.scheduledPosts) };
      const text = locale.reauthRequired;
      const affected =
        email.scheduledPosts === 0
          ? []
          : [format(email.scheduledPosts === 1 ? text.affectedOne : text.affectedMany, values)];
      return {
        ...base,
        subject: format(text.subject, values),
        preview: format(text.preview, values),
        greeting,
        intro: [format(text.intro, values), ...affected],
        action: text.action,
        notes: [common.settingsHint],
      };
    }
    case 'publish-failed': {
      const values = {
        ...namesOf(email, locale),
        reason: locale.failureReasons[email.failureCode],
        preview: email.preview,
      };
      const text = locale.publishFailed;
      return {
        ...base,
        subject: format(text.subject, values),
        preview: format(text.preview, values),
        greeting,
        intro: [format(text.intro, values), format(text.reason, values), format(text.post, values)],
        action: text.action,
        notes: [common.settingsHint],
      };
    }
    case 'needs-attention': {
      const values = { ...namesOf(email, locale), preview: email.preview };
      const text = locale.needsAttention;
      return {
        ...base,
        subject: format(text.subject, values),
        preview: text.preview,
        greeting,
        intro: [format(text.intro, values), format(text.post, values)],
        action: text.action,
        notes: [common.settingsHint],
      };
    }
    case 'x-browser-breaker': {
      const values = {
        count: String(email.drifts),
        selector: email.selector,
        flow: email.flow,
        version: email.selectorsVersion,
      };
      const text = locale.xBrowserBreaker;
      return {
        ...base,
        subject: text.subject,
        preview: text.preview,
        greeting,
        intro: [format(text.intro, values)],
        action: text.action,
        notes: [text.next],
      };
    }
    case 'x-browser-canary': {
      const values = { missing: email.missing.join(', '), version: email.selectorsVersion };
      const text = locale.xBrowserCanary;
      return {
        ...base,
        subject: text.subject,
        preview: text.preview,
        greeting,
        intro: [format(email.missing.length > 0 ? text.intro : text.introWithout, values)],
        action: text.action,
        notes: [text.next],
      };
    }
    case 'billing-read-only': {
      const values = { organization: email.organizationName };
      const text = locale.billingReadOnly;
      return {
        ...base,
        subject: format(text.subject[email.reason], values),
        preview: text.preview,
        greeting,
        intro: [format(text.intro[email.reason], values), text.effects],
        action: text.action,
        notes: [text.kept],
      };
    }
    case 'billing-payment-failed': {
      // The moment the organization becomes read-only, in the time zone of the owner.
      const values = {
        organization: email.organizationName,
        date: new Intl.DateTimeFormat(email.locale, {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: email.timeZone,
        }).format(new Date(email.graceEndsAt)),
      };
      const text = locale.billingPaymentFailed;
      return {
        ...base,
        subject: format(text.subject, values),
        preview: format(text.preview, values),
        greeting,
        intro: [format(text.intro, values), format(text.grace, values)],
        action: text.action,
        notes: [],
      };
    }
    case 'gdpr-export-ready': {
      // Until when the archive exists, in the time zone of the owner.
      const values = {
        organization: email.organizationName,
        date: new Intl.DateTimeFormat(email.locale, {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: email.timeZone,
        }).format(new Date(email.expiresAt)),
      };
      const text = locale.gdprExportReady;
      return {
        ...base,
        subject: format(text.subject, values),
        preview: format(text.preview, values),
        greeting,
        intro: [format(text.intro, values), format(text.download, values)],
        action: text.action,
        notes: [],
      };
    }
  }
}

/** The platform and the accounts of a notification, as the text names them. */
function namesOf(
  email: { platform: keyof EmailMessages['platforms']; accounts: string[]; moreAccounts: number },
  locale: EmailMessages,
): { platform: string; accounts: string } {
  const names = email.accounts.join(', ');
  return {
    platform: locale.platforms[email.platform],
    accounts: email.moreAccounts > 0 ? `${names} (+${String(email.moreAccounts)})` : names,
  };
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
