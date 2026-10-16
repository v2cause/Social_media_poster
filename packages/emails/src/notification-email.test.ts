import type { NotificationEmail } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { notificationEmailOf } from './notification-email';
import { renderEmail } from './render';

// Guide step 4.9: a notification becomes the email of its type, in the language of the
// recipient, with the link to where the recipient acts.

const APP_URL = 'http://localhost:3000';

const email = (content: NotificationEmail['content'], locale: 'de' | 'en' = 'de'): NotificationEmail => ({
  eventId: 'event-1',
  recipient: { userId: 'u-1', email: 'olivia@demo.local', name: 'Olivia', locale },
  workspace: { id: 'ws-1', slug: 'nordlicht', name: 'Nordlicht', timeZone: 'Europe/Berlin' },
  content,
});

describe('notificationEmailOf', () => {
  it('links a connection to the accounts page and dates it in the workspace time zone', async () => {
    const input = notificationEmailOf(
      email({
        type: 'token-expiring',
        connectionId: 'connection-1',
        platform: 'LINKEDIN',
        accounts: ['Mira', 'Nordlicht Haustechnik'],
        daysLeft: 7,
        expiresAt: '2026-10-23T22:30:00.000Z',
      }),
      APP_URL,
    );

    expect(input).toEqual({
      template: 'token-expiring',
      locale: 'de',
      name: 'Olivia',
      platform: 'LINKEDIN',
      accounts: ['Mira', 'Nordlicht Haustechnik'],
      moreAccounts: 0,
      url: 'http://localhost:3000/w/nordlicht/accounts',
      expiresAt: '2026-10-23T22:30:00.000Z',
      timeZone: 'Europe/Berlin',
    });
    expect((await renderEmail(input)).subject).toBe(
      'Der Zugang zu Mira, Nordlicht Haustechnik läuft am 24. Oktober 2026 ab',
    );
  });

  it('links a post, names three accounts at most and stands in the platform for none', async () => {
    const failed = notificationEmailOf(
      email(
        {
          type: 'publish-failed',
          postId: '0192f5d4-0000-7000-8000-000000000001',
          variantId: 'variant-1',
          platform: 'FACEBOOK',
          accounts: [],
          preview: 'Wir suchen Verstärkung.',
          failureCode: 'MISSED_WINDOW',
        },
        'en',
      ),
      APP_URL,
    );
    expect(failed).toMatchObject({
      url: 'http://localhost:3000/w/nordlicht/posts/0192f5d4-0000-7000-8000-000000000001',
      accounts: ['Facebook'],
      locale: 'en',
    });
    await expect(renderEmail(failed)).resolves.toMatchObject({
      subject: 'A post on Facebook was not published',
    });

    const reauth = notificationEmailOf(
      email({
        type: 'reauth-required',
        connectionId: 'connection-1',
        platform: 'FACEBOOK',
        accounts: ['A', 'B', 'C', 'D', 'E'],
        reason: 'EXPIRED',
        scheduledVariants: 2,
      }),
      APP_URL,
    );
    expect(reauth).toMatchObject({ accounts: ['A', 'B', 'C'], moreAccounts: 2, scheduledPosts: 2 });
    expect((await renderEmail(reauth)).subject).toBe('Die Verbindung zu A, B, C (+2) muss erneuert werden');
  });

  it('greets without a name when the recipient has none', () => {
    const input = notificationEmailOf(
      {
        ...email({
          type: 'needs-attention',
          postId: 'p-1',
          variantId: 'variant-1',
          platform: 'X',
          accounts: ['@nordlicht'],
          preview: 'Neu im Team',
          failureCode: 'OUTCOME_UNKNOWN',
        }),
        recipient: { userId: 'u-2', email: 'admin@demo.local', name: null, locale: 'en' },
      },
      APP_URL,
    );

    expect(input).not.toHaveProperty('name');
    expect(input).toMatchObject({
      template: 'needs-attention',
      url: 'http://localhost:3000/w/nordlicht/posts/p-1',
    });
  });
});
