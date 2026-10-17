import { describe, expect, it } from 'vitest';

import { deliverEmail, renderEmail } from './render';

const url = 'http://localhost:3000/api/auth/verify-email?token=abc&callbackURL=%2Fonboarding';

describe('renderEmail', () => {
  it('renders the verification email in German with HTML and text part', async () => {
    const email = await renderEmail({ template: 'verify-email', locale: 'de', name: 'Ada', url });

    expect(email.subject).toBe('Bestätigen Sie Ihre E-Mail-Adresse');
    expect(email.html).toContain('lang="de"');
    expect(email.html).toContain('Hallo Ada,');
    expect(email.html).toContain(url.replaceAll('&', '&amp;'));
    expect(email.text).toContain('E-Mail-Adresse bestätigen');
    expect(email.text).toContain(url);
  });

  it('renders the password reset email in English', async () => {
    const email = await renderEmail({ template: 'reset-password', locale: 'en', name: undefined, url });

    expect(email.subject).toBe('Reset your password');
    expect(email.html).toContain('Hello,');
    expect(email.text).toContain('Choose a new password');
  });

  it('escapes the name and loads nothing remote', async () => {
    const email = await renderEmail({
      template: 'verify-email',
      locale: 'en',
      name: '<img src=x onerror=alert(1)>',
      url,
    });

    expect(email.html).not.toContain('<img');
    expect(email.html).not.toMatch(/src=["']https?:/);
  });

  it('rejects links that are not http(s)', async () => {
    await expect(
      renderEmail({ template: 'verify-email', locale: 'de', name: 'Ada', url: 'javascript:alert(1)' }),
    ).rejects.toThrow();
  });

  it('renders the invitation in both languages with organization, inviter and role', async () => {
    const invitation = {
      template: 'invitation' as const,
      url: 'http://localhost:3000/invite/abc',
      organizationName: 'Acme GmbH',
      inviterName: 'Olivia',
      role: 'EDITOR' as const,
    };
    const de = await renderEmail({ ...invitation, locale: 'de' });
    const en = await renderEmail({ ...invitation, locale: 'en' });

    expect(de.subject).toBe('Einladung zu Acme GmbH');
    expect(de.text).toContain('Olivia hat Sie eingeladen, der Organisation Acme GmbH');
    expect(de.text).toContain('Ihre Rolle: Redakteur.');
    expect(de.text).toContain('http://localhost:3000/invite/abc');
    expect(en.subject).toBe('Invitation to Acme GmbH');
    expect(en.text).toContain('Your role: Editor.');
    expect(en.html).toContain('lang="en"');
  });

  it('delivers the rendered email to the mail port', async () => {
    const sent: unknown[] = [];
    await deliverEmail({ send: (message) => Promise.resolve(void sent.push(message)) }, 'ada@example.test', {
      template: 'verify-email',
      locale: 'en',
      name: 'Ada',
      url,
    });
    expect(sent).toEqual([
      expect.objectContaining({ to: 'ada@example.test', subject: 'Confirm your email address' }),
    ]);
  });
});

describe('the notification emails of guide step 4.9', () => {
  const base = {
    name: 'Olivia',
    url: 'http://localhost:3000/w/nordlicht/accounts',
    platform: 'LINKEDIN' as const,
    accounts: ['Mira', 'Nordlicht Haustechnik'],
  };

  it('names the date the access ends, in the time zone of the workspace', async () => {
    const email = {
      ...base,
      template: 'token-expiring' as const,
      expiresAt: '2026-10-23T22:30:00.000Z',
      timeZone: 'Europe/Berlin',
    };
    const de = await renderEmail({ ...email, locale: 'de' });
    const en = await renderEmail({ ...email, locale: 'en' });

    expect(de.subject).toBe('Der Zugang zu Mira, Nordlicht Haustechnik läuft am 24. Oktober 2026 ab');
    expect(de.text).toContain('Hallo Olivia,');
    expect(de.text).toContain('auf LinkedIn läuft am 24. Oktober 2026 ab');
    expect(de.text).toContain('Neu verbinden');
    expect(de.text).toContain('Kontoeinstellungen');
    expect(en.subject).toBe('Access to Mira, Nordlicht Haustechnik ends on October 24, 2026');
  });

  it('counts the scheduled posts a new grant affects', async () => {
    const email = { ...base, template: 'reauth-required' as const, locale: 'de' as const };

    expect((await renderEmail({ ...email, scheduledPosts: 0 })).text).not.toContain('betroffen');
    expect((await renderEmail({ ...email, scheduledPosts: 1 })).text).toContain(
      'Ein geplanter Post ist betroffen.',
    );
    expect((await renderEmail({ ...email, scheduledPosts: 3 })).text).toContain(
      '3 geplante Posts sind betroffen.',
    );
    expect((await renderEmail({ ...email, locale: 'en', scheduledPosts: 3 })).subject).toBe(
      'Reconnect Mira, Nordlicht Haustechnik',
    );
  });

  it('gives the reason of a failed post and escapes its text', async () => {
    const email = await renderEmail({
      ...base,
      template: 'publish-failed',
      locale: 'de',
      url: 'http://localhost:3000/w/nordlicht/posts/p-1',
      preview: 'Neu: <b>Ausbildung</b> 2027',
      failureCode: 'MISSED_WINDOW',
    });

    expect(email.subject).toBe('Ein Post auf LinkedIn wurde nicht veröffentlicht');
    expect(email.text).toContain('Grund: Der geplante Zeitpunkt lag mehr als 6 Stunden zurück.');
    expect(email.text).toContain('Post: „Neu: <b>Ausbildung</b> 2027“');
    expect(email.html).not.toContain('<b>Ausbildung</b>');
    expect(email.text).toContain('Post öffnen');
  });

  it('asks for a decision in both languages', async () => {
    const email = {
      ...base,
      template: 'needs-attention' as const,
      url: 'http://localhost:3000/w/nordlicht/posts/p-1',
      preview: 'Wir suchen Verstärkung.',
    };
    const de = await renderEmail({ ...email, locale: 'de' });
    const en = await renderEmail({ ...email, locale: 'en' });

    expect(de.subject).toBe('Ein Post auf LinkedIn braucht Ihre Entscheidung');
    expect(de.text).toContain('„Erneut prüfen“, „Trotzdem posten“ oder „Verwerfen“');
    expect(en.text).toContain('“Check again”, “Post anyway” or “Discard”');
  });

  it('names three accounts and counts the others', async () => {
    const email = await renderEmail({
      ...base,
      template: 'reauth-required',
      locale: 'de',
      accounts: ['A', 'B', 'C'],
      moreAccounts: 4,
      scheduledPosts: 0,
    });

    expect(email.subject).toBe('Die Verbindung zu A, B, C (+4) muss erneuert werden');
  });

  it('refuses a notification without accounts or with an unknown time zone', async () => {
    await expect(
      renderEmail({ ...base, template: 'needs-attention', locale: 'de', accounts: [], preview: 'x' }),
    ).rejects.toThrow();
    await expect(
      renderEmail({
        ...base,
        template: 'token-expiring',
        locale: 'de',
        expiresAt: '2026-10-23T22:30:00.000Z',
        timeZone: 'Mars/Olympus',
      }),
    ).rejects.toThrow();
  });

  it('tells the platform admins that the circuit breaker stopped X without the API', async () => {
    const breaker = {
      template: 'x-browser-breaker' as const,
      url: 'http://localhost:3000/admin',
      drifts: 3,
      flow: 'publish',
      selector: 'composer.textbox',
      selectorsVersion: 'x-v1',
    };
    const de = await renderEmail({ ...breaker, locale: 'de', name: 'Ops' });
    const en = await renderEmail({ ...breaker, locale: 'en' });

    expect(de.subject).toBe('X ohne API wurde automatisch gestoppt');
    expect(de.text).toContain('Hallo Ops,');
    expect(de.text).toContain(
      '3 Abweichungen der Selector-Map innerhalb einer Stunde, zuletzt „composer.textbox“ im Ablauf „publish“ (Selector-Map x-v1).',
    );
    expect(de.text).toContain('http://localhost:3000/admin');
    expect(en.subject).toBe('X without the API was stopped automatically');
    expect(en.text).toContain('lift the kill switch on the platform admin page');
  });

  it('names the selectors a failed canary missed, or says it named none', async () => {
    const canary = {
      template: 'x-browser-canary' as const,
      locale: 'de' as const,
      url: 'http://localhost:3000/admin',
      selectorsVersion: 'x-v1',
    };
    const named = await renderEmail({ ...canary, missing: ['composer.textbox', 'nav.profile'] });
    const none = await renderEmail({ ...canary, missing: [] });

    expect(named.subject).toBe('Der Canary von X ohne API ist fehlgeschlagen');
    expect(named.text).toContain('nicht gefunden: composer.textbox, nav.profile.');
    expect(none.text).toContain('ohne fehlende Einträge der Selector-Map x-v1 zu nennen.');
    await expect(
      renderEmail({ ...canary, missing: Array.from({ length: 21 }, () => 'a') }),
    ).rejects.toThrow();
  });
});

describe('the billing emails of guide step 7.4', () => {
  const failed = {
    template: 'billing-payment-failed' as const,
    url: 'http://localhost:3000/org/0192f000-0000-7000-8000-000000000001/billing',
    organizationName: 'Acme GmbH',
    graceEndsAt: '2026-10-24T12:00:00.000Z',
  };

  it('tells the owners until when the organization stays writable, in their time zone', async () => {
    const de = await renderEmail({ ...failed, locale: 'de', name: 'Olga', timeZone: 'Europe/Berlin' });
    const en = await renderEmail({ ...failed, locale: 'en', timeZone: 'America/New_York' });

    expect(de.subject).toBe('Die Zahlung für Acme GmbH ist fehlgeschlagen');
    expect(de.text).toContain('Hallo Olga,');
    expect(de.text).toContain('Bis 24. Oktober 2026 um 14:00 können Sie wie gewohnt weiterarbeiten.');
    expect(de.text).toContain('kann Acme GmbH nur noch lesen: Geplante Posts werden pausiert');
    expect(de.text).toContain(failed.url);
    expect(en.subject).toBe('The payment for Acme GmbH failed');
    expect(en.text).toContain('Until October 24, 2026 at 8:00');
    expect(en.text).toContain('Open billing');
  });

  it('rejects an unknown time zone', async () => {
    await expect(renderEmail({ ...failed, locale: 'de', timeZone: 'Mars/Olympus' })).rejects.toThrow();
  });
});
