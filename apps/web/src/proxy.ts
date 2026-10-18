import { type NextRequest, NextResponse } from 'next/server';

import { buildContentSecurityPolicy, createNonce, storageOrigins } from './security/content-security-policy';

// Sets the Content Security Policy with a fresh nonce for every page request. Next.js reads the
// policy from the request headers and adds the nonce to its scripts during rendering.
//
// The redirect to the sign-in is optimistic: it only looks for the session cookie, so a signed-out
// visitor does not load an app page first. It is not a security boundary; the layouts check the
// session against the API, and the API authorizes every call again.

const PROTECTED = ['/w/', '/org/', '/account', '/onboarding'];
// Better Auth's session cookie, with the prefix "__Host-" when cookies are secure (guide step 8.4).
const SESSION_COOKIES = ['smp.session_token', '__Host-smp.session_token'];

function needsSignIn(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED.some(
    (prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix),
  );
  return isProtected && !SESSION_COOKIES.some((name) => request.cookies.has(name));
}

export function proxy(request: NextRequest): NextResponse {
  if (needsSignIn(request)) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }

  const nonce = createNonce();
  const policy = buildContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === 'development',
    storageOrigins(process.env),
  );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Not for the API under /api/ (it sets its own headers), static files, or link prefetches.
      // Other paths that only start with "api" are pages of the web app and get the policy.
      source: '/((?!api/|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
