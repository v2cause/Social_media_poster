import { type NextRequest, NextResponse } from 'next/server';

import { buildContentSecurityPolicy, createNonce } from './security/content-security-policy';

// Sets the Content Security Policy with a fresh nonce for every page request. Next.js reads the
// policy from the request headers and adds the nonce to its scripts during rendering.
//
// Optimistic checks only otherwise. This is not a security boundary: every API call is authorized
// again on the server. Redirects for protected routes arrive with the sign-in pages (step 1.9).
export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');

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
      // Not for the API (it sets its own headers), static files, or link prefetches.
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
