import type { MockConsentLinks } from '@smp/platform-adapters';
import type { Platform } from '@smp/platform-rules';

// The consent page of the mock platforms (guide step 4.4). It is a development tool outside the
// web app, so its texts live here in German and English. The locale follows the NEXT_LOCALE
// cookie of the web app, then Accept-Language, then German.

export const PAGE_LOCALES = ['de', 'en'] as const;
export type PageLocale = (typeof PAGE_LOCALES)[number];

const PLATFORM_NAMES: Readonly<Record<Platform, string>> = {
  LINKEDIN: 'LinkedIn',
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook',
  X: 'X',
};

interface PageMessages {
  title: (platform: string) => string;
  notice: (platform: string) => string;
  request: string;
  allow: string;
  partial: (scope: string) => string;
  deny: string;
}

const MESSAGES: Readonly<Record<PageLocale, PageMessages>> = {
  de: {
    title: (platform) => `Mock-Anmeldung bei ${platform}`,
    notice: (platform) =>
      `Diese Seite ersetzt in der Entwicklung die Anmeldung bei ${platform}. Es wird nichts an ${platform} gesendet.`,
    request: 'Social Media Poster bittet um Zugriff auf Ihr Konto mit diesen Berechtigungen:',
    allow: 'Zugriff erlauben',
    partial: (scope) => `Ohne „${scope}“ erlauben`,
    deny: 'Ablehnen',
  },
  en: {
    title: (platform) => `Mock sign-in to ${platform}`,
    notice: (platform) =>
      `In development, this page stands in for the sign-in to ${platform}. Nothing is sent to ${platform}.`,
    request: 'Social Media Poster asks for access to your account with these permissions:',
    allow: 'Allow access',
    partial: (scope) => `Allow without "${scope}"`,
    deny: 'Deny',
  },
};

const isPageLocale = (value: string): value is PageLocale =>
  (PAGE_LOCALES as readonly string[]).includes(value);

/** The locale of the page from the request headers. */
export function pageLocaleOf(headers: { cookie?: string; acceptLanguage?: string }): PageLocale {
  const cookie = /(?:^|;\s*)NEXT_LOCALE=([a-z]{2})(?:;|$)/.exec(headers.cookie ?? '')?.[1];
  if (cookie && isPageLocale(cookie)) {
    return cookie;
  }
  for (const range of (headers.acceptLanguage ?? '').split(',')) {
    const language = range.trim().split(/[-;]/)[0]?.toLowerCase() ?? '';
    if (isPageLocale(language)) {
      return language;
    }
  }
  return 'de';
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

export interface MockConsentPage {
  platform: Platform;
  scopes: readonly string[];
  links: MockConsentLinks;
  locale: PageLocale;
}

export function renderMockConsentPage(page: MockConsentPage): string {
  const messages = MESSAGES[page.locale];
  const name = PLATFORM_NAMES[page.platform];
  const link = (href: string, label: string, kind: string): string =>
    `<a class="${kind}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  const scopes = page.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join('');
  const actions = [
    link(page.links.allow, messages.allow, 'primary'),
    page.links.partial
      ? link(page.links.partial.url, messages.partial(page.links.partial.without), 'secondary')
      : '',
    link(page.links.deny, messages.deny, 'secondary'),
  ].join('');

  return `<!doctype html>
<html lang="${page.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(messages.title(name))}</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 32px 16px; display: flex; justify-content: center; }
main { max-width: 480px; width: 100%; }
.badge { display: inline-block; padding: 2px 8px; border: 1px solid currentColor; border-radius: 999px; font-size: 12px; }
.notice { opacity: 0.75; }
ul { padding-left: 20px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
.actions a { padding: 8px 16px; border-radius: 6px; border: 1px solid currentColor; text-decoration: none; color: inherit; }
.actions a.primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
</style>
</head>
<body>
<main>
<p class="badge">Mock</p>
<h1>${escapeHtml(messages.title(name))}</h1>
<p class="notice">${escapeHtml(messages.notice(name))}</p>
<p>${escapeHtml(messages.request)}</p>
<ul>${scopes}</ul>
<div class="actions">${actions}</div>
</main>
</body>
</html>
`;
}
