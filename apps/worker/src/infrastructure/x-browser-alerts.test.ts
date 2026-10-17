import type { EmailTemplateInput } from '@smp/emails';
import { describe, expect, it } from 'vitest';

import { EmailXBrowserAlerts } from './x-browser-alerts';

// Guide step 6.5: every platform admin gets the alert in their language, with a link to the admin
// page; a canary names at most twenty selectors.

describe('EmailXBrowserAlerts', () => {
  it('emails every platform admin in their language', async () => {
    const sent: [string, EmailTemplateInput][] = [];
    const alerts = new EmailXBrowserAlerts({
      admins: {
        platformAdmins: () =>
          Promise.resolve([
            { email: 'ops@example.test', name: 'Ops', locale: 'en' },
            { email: 'betrieb@example.test', name: 'Betrieb', locale: 'fr' },
          ]),
      },
      notifications: {
        dispatchEmail: (to, email) => {
          sent.push([to, email]);
          return Promise.resolve();
        },
      },
      adminUrl: 'http://localhost:3000/admin',
    });

    await alerts.breakerOpened({
      drifts: 3,
      flow: 'publish',
      selector: 'composer.textbox',
      selectorsVersion: 'x-v1',
    });
    await alerts.canaryFailed({
      missing: Array.from({ length: 25 }, (_, index) => `selector.${String(index)}`),
      selectorsVersion: 'x-v1',
    });

    expect(sent.map(([to, email]) => [to, email.template, email.locale])).toEqual([
      ['ops@example.test', 'x-browser-breaker', 'en'],
      // An unknown language falls back to German.
      ['betrieb@example.test', 'x-browser-breaker', 'de'],
      ['ops@example.test', 'x-browser-canary', 'en'],
      ['betrieb@example.test', 'x-browser-canary', 'de'],
    ]);
    expect(sent[0]?.[1]).toMatchObject({ url: 'http://localhost:3000/admin', drifts: 3, name: 'Ops' });
    const canary = sent[2]?.[1];
    expect(canary?.template === 'x-browser-canary' ? canary.missing : []).toHaveLength(20);
  });
});
