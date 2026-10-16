import { ApiError } from '@smp/api-client';
import { ERROR_CODES, type ErrorCode } from '@smp/contracts';

const KNOWN_CODES = new Set<string>(ERROR_CODES);

/** The translation key of an API error or an error code under errors.codes, or "unknown". */
export function errorCodeOf(error: unknown): ErrorCode | 'unknown' {
  const code = error instanceof ApiError ? error.code : typeof error === 'string' ? error : null;
  return code !== null && KNOWN_CODES.has(code) ? (code as ErrorCode) : 'unknown';
}
