import type { NotificationEmail } from '@smp/core';

import { messages } from './messages';
import { NAMED_ACCOUNTS, type EmailTemplateInput } from './render';

// The email of a notification (guide step 4.9, ADR 0025): the template of its type in the
// language of the recipient, linking to where the recipient acts: the accounts page for a
// connection, the post for a variant.

/** The template input of a notification email; appUrl is the origin of the web app. */
export function notificationEmailOf(email: NotificationEmail, appUrl: string): EmailTemplateInput {
  const { recipient, workspace, content } = email;
  const link = (path: string): string =>
    new URL(`/w/${encodeURIComponent(workspace.slug)}/${path}`, appUrl).toString();
  // Without a connected account left, the platform stands for it.
  const accounts =
    content.accounts.length > 0 ? content.accounts : [messages[recipient.locale].platforms[content.platform]];
  const common = {
    locale: recipient.locale,
    ...(recipient.name ? { name: recipient.name } : {}),
    platform: content.platform,
    accounts: accounts.slice(0, NAMED_ACCOUNTS),
    moreAccounts: Math.max(0, accounts.length - NAMED_ACCOUNTS),
  };
  switch (content.type) {
    case 'token-expiring':
      return {
        template: 'token-expiring',
        ...common,
        url: link('accounts'),
        expiresAt: content.expiresAt,
        timeZone: workspace.timeZone,
      };
    case 'reauth-required':
      return {
        template: 'reauth-required',
        ...common,
        url: link('accounts'),
        scheduledPosts: content.scheduledVariants,
      };
    case 'publish-failed':
      return {
        template: 'publish-failed',
        ...common,
        url: link(`posts/${encodeURIComponent(content.postId)}`),
        preview: content.preview,
        failureCode: content.failureCode,
      };
    case 'needs-attention':
      return {
        template: 'needs-attention',
        ...common,
        url: link(`posts/${encodeURIComponent(content.postId)}`),
        preview: content.preview,
      };
  }
}
