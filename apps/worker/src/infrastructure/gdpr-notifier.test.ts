import type { EmailTemplateInput } from '@smp/emails';
import { describe, expect, it } from 'vitest';

import { EmailGdprNotifier } from './gdpr-notifier';

// Guide step 8.1: the owner who asked hears that the export is ready, in their language and time
// zone, with a link to the data page and never to the archive; when that owner is gone, every
// owner hears it. The request keys each email.

const ORG = '0192f000-0000-7000-8000-000000000001';
const REQUEST = '0192f000-0000-7000-8000-0000000000e1';

function notifierWithOwners(sent: [string, string, string, EmailTemplateInput][]) {
  return new EmailGdprNotifier({
    directory: {
      owners: (organizationId) =>
        Promise.resolve(
          organizationId === ORG
            ? {
                organizationName: 'Acme GmbH',
                owners: [
                  {
                    userId: 'user-1',
                    email: 'olga@acme.test',
                    name: 'Olga',
                    locale: 'de',
                    timezone: 'Europe/Berlin',
                  },
                  { userId: 'user-2', email: 'otto@acme.test', name: 'Otto', locale: 'en', timezone: 'UTC' },
                ],
              }
            : null,
        ),
    },
    notifications: {
      dispatchEventEmail: (eventId, userId, to, email) => {
        sent.push([eventId, userId, to, email]);
        return Promise.resolve();
      },
    },
    appUrl: 'http://localhost:3000',
  });
}

describe('EmailGdprNotifier', () => {
  const expiresAt = new Date('2026-10-18T12:00:00Z');

  it('emails the owner who asked, with the data page and the end of the download', async () => {
    const sent: [string, string, string, EmailTemplateInput][] = [];

    await notifierWithOwners(sent).exportReady({
      requestId: REQUEST,
      organizationId: ORG,
      requestedById: 'user-2',
      expiresAt,
    });

    expect(sent).toEqual([
      [
        `export.${REQUEST}`,
        'user-2',
        'otto@acme.test',
        {
          template: 'gdpr-export-ready',
          locale: 'en',
          name: 'Otto',
          url: `http://localhost:3000/org/${ORG}/data`,
          organizationName: 'Acme GmbH',
          expiresAt: '2026-10-18T12:00:00.000Z',
          timeZone: 'UTC',
        },
      ],
    ]);
  });

  it('emails every owner when the one who asked is no owner any more', async () => {
    const sent: [string, string, string, EmailTemplateInput][] = [];
    const notifier = notifierWithOwners(sent);

    await notifier.exportReady({
      requestId: REQUEST,
      organizationId: ORG,
      requestedById: 'user-9',
      expiresAt,
    });
    await notifier.exportReady({ requestId: REQUEST, organizationId: ORG, requestedById: null, expiresAt });
    await notifier.exportReady({
      requestId: REQUEST,
      organizationId: '0192f000-0000-7000-8000-000000000002',
      requestedById: 'user-1',
      expiresAt,
    });

    expect(sent.map(([eventId, userId]) => [eventId, userId])).toEqual([
      [`export.${REQUEST}`, 'user-1'],
      [`export.${REQUEST}`, 'user-2'],
      [`export.${REQUEST}`, 'user-1'],
      [`export.${REQUEST}`, 'user-2'],
    ]);
  });
});
