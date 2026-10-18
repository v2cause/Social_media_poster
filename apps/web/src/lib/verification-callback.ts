/**
 * Where the verification link leads: the sign-in, with a notice and the page to go to after it.
 * The link only verifies the address; signing in needs the password (guide step 8.4).
 */
export function verificationCallback(next: string | null): string {
  const query = new URLSearchParams({ verified: '1', next: next ?? '/onboarding' });
  return `/login?${query.toString()}`;
}
