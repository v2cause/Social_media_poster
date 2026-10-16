import { describe, expect, it } from 'vitest';

import {
  DeliverNotification,
  PREVIEW_MAX_UNITS,
  previewOf,
  type InAppNotification,
  type NotificationChannels,
  type NotificationContent,
  type NotificationEmail,
  type NotificationRecipient,
  type NotificationRequest,
} from '../../src';

// Guide step 4.9: the notification of an event goes to its recipients in the channels they want,
// once per user and event, also when the job runs again.

const owner: NotificationRecipient = {
  userId: 'u-owner',
  email: 'owner@demo.local',
  name: 'Olivia',
  locale: 'de',
};
const admin: NotificationRecipient = {
  userId: 'u-admin',
  email: 'admin@demo.local',
  name: null,
  locale: 'en',
};
const editor: NotificationRecipient = {
  userId: 'u-editor',
  email: 'editor@demo.local',
  name: 'Emil',
  locale: 'de',
};
const workspace = { id: 'ws-1', slug: 'nordlicht', name: 'Nordlicht', timeZone: 'Europe/Berlin' };

const failed: NotificationContent = {
  type: 'publish-failed',
  postId: 'post-1',
  variantId: 'variant-1',
  platform: 'LINKEDIN',
  accounts: ['Mira'],
  preview: 'Wir suchen Verstärkung im Kundendienst.',
  failureCode: 'VALIDATION_REJECTED',
};
const expiring: NotificationContent = {
  type: 'token-expiring',
  connectionId: 'connection-1',
  platform: 'LINKEDIN',
  accounts: ['Mira', 'Nordlicht Haustechnik'],
  daysLeft: 7,
  expiresAt: '2026-10-23T12:00:00.000Z',
};

const setup = (options: {
  content: NotificationContent | null;
  author?: NotificationRecipient[];
  channels?: Record<string, NotificationChannels>;
}) => {
  const added: (InAppNotification & { userId: string })[] = [];
  const emails: NotificationEmail[] = [];
  const deliver = new DeliverNotification({
    directory: {
      describe: () => Promise.resolve(options.content ? { workspace, content: options.content } : null),
      channelManagers: () => Promise.resolve([owner, admin, owner]),
      postAuthor: () => Promise.resolve(options.author ?? []),
    },
    inbox: {
      channelsOf: (userId) => Promise.resolve(options.channels?.[userId] ?? { inApp: true, email: true }),
      addOnce: (userId, notification) => {
        if (added.some((row) => row.userId === userId && row.eventId === notification.eventId)) {
          return Promise.resolve(false);
        }
        added.push({ ...notification, userId });
        return Promise.resolve(true);
      },
    },
    mailer: {
      send: (email) => {
        emails.push(email);
        return Promise.resolve();
      },
    },
  });
  const run = (request: NotificationRequest) =>
    deliver.execute({ eventId: 'event-1', organizationId: 'org-1', workspaceId: 'ws-1', request });
  return { run, added, emails };
};

describe('DeliverNotification', () => {
  it('tells the managers of a connection in the app and by email, each once', async () => {
    const { run, added, emails } = setup({ content: expiring });

    await expect(
      run({
        type: 'token-expiring',
        connectionId: 'connection-1',
        daysLeft: 7,
        expiresAt: expiring.expiresAt,
      }),
    ).resolves.toEqual({ recipients: 2, inApp: 2, emails: 2 });

    expect(added.map((row) => [row.userId, row.eventId, row.content.type])).toEqual([
      ['u-owner', 'event-1', 'token-expiring'],
      ['u-admin', 'event-1', 'token-expiring'],
    ]);
    expect(emails.map((email) => [email.recipient.email, email.workspace.slug])).toEqual([
      ['owner@demo.local', 'nordlicht'],
      ['admin@demo.local', 'nordlicht'],
    ]);
  });

  it('tells the author of a failed post, and the managers when the author is gone', async () => {
    const request: NotificationRequest = {
      type: 'publish-failed',
      variantId: 'variant-1',
      failureCode: 'VALIDATION_REJECTED',
    };
    const withAuthor = setup({ content: failed, author: [editor] });
    await expect(withAuthor.run(request)).resolves.toMatchObject({ recipients: 1 });
    expect(withAuthor.emails.map((email) => email.recipient.userId)).toEqual(['u-editor']);

    const authorGone = setup({ content: failed, author: [] });
    await expect(authorGone.run(request)).resolves.toMatchObject({ recipients: 2 });
  });

  it('follows the settings of each recipient', async () => {
    const { run, added, emails } = setup({
      content: expiring,
      channels: { 'u-owner': { inApp: true, email: false }, 'u-admin': { inApp: false, email: false } },
    });

    await expect(
      run({
        type: 'token-expiring',
        connectionId: 'connection-1',
        daysLeft: 7,
        expiresAt: expiring.expiresAt,
      }),
    ).resolves.toEqual({ recipients: 2, inApp: 1, emails: 0 });
    expect(added.map((row) => row.userId)).toEqual(['u-owner']);
    expect(emails).toEqual([]);
  });

  it('adds nothing twice when the job runs again, but hands the emails on again for their job ids', async () => {
    const { run, added, emails } = setup({ content: failed, author: [editor] });
    const request: NotificationRequest = {
      type: 'needs-attention',
      variantId: 'variant-1',
      failureCode: 'OUTCOME_UNKNOWN',
    };

    await run(request);
    await expect(run(request)).resolves.toEqual({ recipients: 1, inApp: 0, emails: 1 });
    expect(added).toHaveLength(1);
    expect(emails).toHaveLength(2);
  });

  it('delivers nothing when the subject is gone', async () => {
    const { run, added, emails } = setup({ content: null });

    await expect(
      run({ type: 'publish-failed', variantId: 'gone', failureCode: 'INTERNAL' }),
    ).resolves.toEqual({
      recipients: 0,
      inApp: 0,
      emails: 0,
    });
    expect([...added, ...emails]).toEqual([]);
  });
});

describe('previewOf', () => {
  it('puts the text on one line and cuts it after 80 characters', () => {
    expect(previewOf('Wir suchen\n\nVerstärkung.  ')).toBe('Wir suchen Verstärkung.');
    const long = 'a'.repeat(100);
    expect(previewOf(long)).toBe(`${'a'.repeat(79)}…`);
    expect(previewOf(long)).toHaveLength(80);
    expect(previewOf(`${'a'.repeat(78)} bcd`)).toBe(`${'a'.repeat(78)}…`);
  });

  it('keeps a text full of emoji short and splits none of them', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const preview = previewOf(family.repeat(100));

    expect(preview.length).toBeLessThanOrEqual(PREVIEW_MAX_UNITS);
    expect(preview).toBe(`${family.repeat(Math.floor((PREVIEW_MAX_UNITS - 1) / family.length))}…`);
  });
});
