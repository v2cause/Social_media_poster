import { NextResponse } from 'next/server';

// Optimistic checks only. This is not a security boundary: every API call is authorized again
// on the server. Redirects for protected routes arrive with the sign-in pages (step 1.9).
export function proxy(): NextResponse {
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
