import { describe, expect, it } from 'vitest';

import { pageLocaleOf, renderMockConsentPage } from './mock-oauth.page';

// The consent page escapes what comes from the request and picks its language like the web app.

describe('pageLocaleOf', () => {
  it('prefers the cookie of the web app, then Accept-Language, then German', () => {
    expect(pageLocaleOf({ cookie: 'a=1; NEXT_LOCALE=en', acceptLanguage: 'de' })).toBe('en');
    expect(pageLocaleOf({ cookie: 'NEXT_LOCALE=fr', acceptLanguage: 'fr-CH, en;q=0.8' })).toBe('en');
    expect(pageLocaleOf({ acceptLanguage: 'de-AT,de;q=0.9' })).toBe('de');
    expect(pageLocaleOf({})).toBe('de');
  });
});

describe('renderMockConsentPage', () => {
  it('escapes scopes and links and leaves out a missing partial grant', () => {
    const html = renderMockConsentPage({
      platform: 'FACEBOOK',
      scopes: ['<script>alert(1)</script>'],
      links: {
        allow: 'http://localhost:3000/api/oauth/facebook/callback?code=a&state="x"',
        partial: null,
        deny: 'http://localhost:3000/api/oauth/facebook/callback?error=access_denied',
      },
      locale: 'de',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('code=a&amp;state=&quot;x&quot;');
    expect(html).not.toContain('Ohne');
    expect(html).toContain('Mock-Anmeldung bei Facebook');
  });
});
