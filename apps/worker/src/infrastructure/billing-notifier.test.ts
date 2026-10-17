import type { EmailTemplateInput } from '@smp/emails';
import { describe, expect, it } from 'vitest';

import { EmailBillingNotifier } from './billing-notifier';

// Guide step 7.4: every owner hears of a failed payment in their language and time zone, with a
// link to the billing page; the Stripe event keys each email.

const ORG = '0192f000-0000-7000-8000-000000000001';

describe('EmailBillingNotifier', () => {
  it('emails every owner once per event, with the end of the grace period', async () => {
    const sent: [string, string, string, EmailTemplateInput][] = [];
    const notifier = new EmailBillingNotifier({
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
                      locale: 'en',
                      timezone: 'America/New_York',
                    },
                    {
                      userId: 'user-2',
                      email: 'otto@acme.test',
                      name: 'Otto',
                      locale: 'fr',
                      timezone: 'Europe/Berlin',
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

    const graceEndsAt = new Date('2026-10-24T12:00:00Z');
    await notifier.paymentFailed({ eventId: 'evt_1', organizationId: ORG, graceEndsAt });
    await notifier.paymentFailed({
      eventId: 'evt_2',
      organizationId: '0192f000-0000-7000-8000-000000000002',
      graceEndsAt,
    });

    expect(sent.map(([eventId, userId, to, email]) => [eventId, userId, to, email.locale])).toEqual([
      ['evt_1', 'user-1', 'olga@acme.test', 'en'],
      // An unknown language falls back to German.
      ['evt_1', 'user-2', 'otto@acme.test', 'de'],
    ]);
    expect(sent[0]?.[3]).toEqual({
      template: 'billing-payment-failed',
      locale: 'en',
      name: 'Olga',
      url: `http://localhost:3000/org/${ORG}/billing`,
      organizationName: 'Acme GmbH',
      graceEndsAt: '2026-10-24T12:00:00.000Z',
      timeZone: 'America/New_York',
    });
  });
});
