import { BadRequestException, NotFoundException } from '@nestjs/common';
import { decodeMockCode, PLATFORM_SCOPES } from '@smp/platform-adapters';
import { describe, expect, it } from 'vitest';

import { MockOAuthController } from './mock-oauth.controller';

// The fake OAuth page answers only for mock platforms outside production and sends back to the
// callback of this app only (guide step 4.4).

const APP_URL = 'http://localhost:3000';
const env = {
  NODE_ENV: 'development' as const,
  APP_URL,
  PLATFORM_MODE_LINKEDIN: 'mock' as const,
  PLATFORM_MODE_META: 'live' as const,
  PLATFORM_MODE_X: 'mock' as const,
};
const query = (overrides: Record<string, string> = {}): Record<string, string> => ({
  platform: 'X',
  state: 'state-0123456789abcdef',
  redirect_uri: `${APP_URL}/api/oauth/x/callback`,
  scope: PLATFORM_SCOPES.X.join(' '),
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  ...overrides,
});

/** The href of a link with its label, from the rendered page. */
const hrefOf = (html: string, label: string): URL => {
  const match = new RegExp(`href="([^"]+)">${label}</a>`).exec(html);
  if (!match?.[1]) {
    throw new Error(`no link "${label}"`);
  }
  return new URL(match[1].replaceAll('&amp;', '&'));
};

describe('MockOAuthController', () => {
  const controller = new MockOAuthController(env);

  it('renders the consent page with links back to the callback', () => {
    const html = controller.authorize(query(), undefined, 'en-US,en;q=0.9');

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Mock sign-in to X');
    const allow = hrefOf(html, 'Allow access');
    expect(`${allow.origin}${allow.pathname}`).toBe(`${APP_URL}/api/oauth/x/callback`);
    expect(decodeMockCode(allow.searchParams.get('code') ?? '')).toMatchObject({
      platform: 'X',
      challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    });
    expect(hrefOf(html, 'Deny').searchParams.get('error')).toBe('access_denied');
    expect(html).toContain('Allow without &quot;offline.access&quot;');
  });

  it('speaks German from the cookie of the web app', () => {
    const html = controller.authorize(
      query({ platform: 'LINKEDIN', redirect_uri: `${APP_URL}/api/oauth/linkedin/callback` }),
      'NEXT_LOCALE=de',
      'en',
    );

    expect(html).toContain('<html lang="de">');
    expect(hrefOf(html, 'Zugriff erlauben').pathname).toBe('/api/oauth/linkedin/callback');
    expect(html).toContain('Ablehnen');
  });

  it('sends back to the callback of this app only', () => {
    for (const redirect of [
      'https://evil.example/api/oauth/x/callback',
      `${APP_URL}/api/oauth/linkedin/callback`,
      `${APP_URL}/api/oauth/x/callback?next=https://evil.example`,
    ]) {
      expect(() => controller.authorize(query({ redirect_uri: redirect }))).toThrow(BadRequestException);
    }
  });

  it('refuses malformed requests', () => {
    const malformed: Record<string, string>[] = [
      { platform: 'MYSPACE' },
      { state: 'short' },
      { scope: '' },
      { code_challenge_method: 'plain' },
      { code_challenge: 'too-short' },
    ];
    for (const overrides of malformed) {
      expect(() => controller.authorize(query(overrides))).toThrow(BadRequestException);
    }
    const withoutMethod = query();
    delete withoutMethod['code_challenge_method'];
    expect(() => controller.authorize(withoutMethod)).toThrow(BadRequestException);
  });

  it('does not exist for live platforms or in production', () => {
    expect(() =>
      controller.authorize(
        query({ platform: 'FACEBOOK', redirect_uri: `${APP_URL}/api/oauth/facebook/callback` }),
      ),
    ).toThrow(NotFoundException);
    expect(() => new MockOAuthController({ ...env, NODE_ENV: 'production' }).authorize(query())).toThrow(
      NotFoundException,
    );
  });
});
