import { createHash } from 'node:crypto';

import { PLATFORMS, type Platform } from '@smp/platform-rules';
import { z } from 'zod';

// The authorization codes of the mock OAuth page (/api/dev/mock-oauth/authorize). The page and
// the mock connector share this format: who granted which scopes, the PKCE challenge and the
// expiry. Not signed: the page exists only with PLATFORM_MODE_*=mock outside production.

const codeSchema = z.object({
  platform: z.enum(PLATFORMS),
  user: z.string().regex(/^[a-z0-9-]{1,40}$/),
  scopes: z.array(z.string().max(80)).max(20),
  challenge: z.string().max(128).nullable(),
  expiresAt: z.number().int(),
});
export type MockAuthorizationCode = z.infer<typeof codeSchema>;

const PREFIX = 'mock.';

export const encodeMockCode = (code: MockAuthorizationCode): string =>
  PREFIX + Buffer.from(JSON.stringify(codeSchema.parse(code))).toString('base64url');

/** The content of a code; null for anything that is not one. */
export function decodeMockCode(value: string): MockAuthorizationCode | null {
  if (!value.startsWith(PREFIX)) {
    return null;
  }
  try {
    const parsed = codeSchema.safeParse(
      JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString()),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The S256 challenge of a PKCE verifier (RFC 7636). */
export const pkceChallengeOf = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export const isPlatform = (value: string): value is Platform =>
  (PLATFORMS as readonly string[]).includes(value);
