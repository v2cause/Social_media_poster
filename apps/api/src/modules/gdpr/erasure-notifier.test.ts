import type { EmailTemplateInput } from '@smp/emails';
import { describe, expect, it } from 'vitest';

import { EmailErasureNotifier } from './erasure-notifier';

// Guide step 8.2: after the deletion every owner hears on which day the organization is erased,
// in their language and time zone, with a link to the data page. The request keys each email.

const ORG = '0192f000-0000-7000-8000-000000000001';
const REQUEST = '0192f000-0000-7000-8000-0000000000e9';

describe('EmailErasureNotifier', () => {
  it('emails every owner the day of the erasure and the data page', async () => {
    const sent: [string, string, string, EmailTemplateInput][] = [];
    const notifier = new EmailErasureNotifier({
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
                    {
                      userId: 'user-2',
                      email: 'otto@acme.test',
                      name: 'Otto',
                      locale: 'en',
                      timezone: 'UTC',
                    },
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
    const eraseAfter = new Date('2026-11-16T12:00:00Z');

    await notifier.erasureScheduled({ requestId: REQUEST, organizationId: ORG, eraseAfter });
    await notifier.erasureScheduled({
      requestId: REQUEST,
      organizationId: '0192f000-0000-7000-8000-000000000002',
      eraseAfter,
    });

    expect(sent).toEqual([
      [
        `erasure.${REQUEST}`,
        'user-1',
        'olga@acme.test',
        {
          template: 'gdpr-erasure-scheduled',
          locale: 'de',
          name: 'Olga',
          url: `http://localhost:3000/org/${ORG}/data`,
          organizationName: 'Acme GmbH',
          eraseAfter: '2026-11-16T12:00:00.000Z',
          timeZone: 'Europe/Berlin',
        },
      ],
      [
        `erasure.${REQUEST}`,
        'user-2',
        'otto@acme.test',
        {
          template: 'gdpr-erasure-scheduled',
          locale: 'en',
          name: 'Otto',
          url: `http://localhost:3000/org/${ORG}/data`,
          organizationName: 'Acme GmbH',
          eraseAfter: '2026-11-16T12:00:00.000Z',
          timeZone: 'UTC',
        },
      ],
    ]);
  });
});
