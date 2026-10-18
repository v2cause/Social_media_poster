'use client';

import { useTranslations } from 'next-intl';

const KNOWN = [
  'INVALID_EMAIL_OR_PASSWORD',
  'EMAIL_NOT_VERIFIED',
  'USER_ALREADY_EXISTS',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'INVALID_TOKEN',
  'INVALID_CODE',
  'INVALID_TWO_FACTOR_COOKIE',
  'INVALID_PASSWORD',
  // The limit of failed attempts per account or user of the API (guide step 8.4).
  'TOO_MANY_ATTEMPTS',
] as const;
type KnownCode = (typeof KNOWN)[number];

/** Better Auth's error: a code such as INVALID_EMAIL_OR_PASSWORD and the HTTP status. */
export interface AuthClientError {
  code?: string;
  status?: number;
}

/** Translates a Better Auth error. Unknown codes get a general message, never the server text. */
export function useAuthError() {
  const t = useTranslations('auth.errors');
  return (error: AuthClientError | null | undefined): string | null => {
    if (!error) {
      return null;
    }
    const code = KNOWN.find((known): known is KnownCode => known === error.code);
    if (code) {
      return t(code);
    }
    return error.status === 429 ? t('TOO_MANY_REQUESTS') : t('unknown');
  };
}
