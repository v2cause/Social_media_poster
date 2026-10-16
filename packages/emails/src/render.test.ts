import { describe, expect, it } from 'vitest';

import { renderEmail } from './render';

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
});
