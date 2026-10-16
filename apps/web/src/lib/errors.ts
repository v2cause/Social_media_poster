import { ApiError } from '@smp/api-client';
import { ERROR_CODES, type ErrorCode } from '@smp/contracts';

const KNOWN_CODES = new Set<string>(ERROR_CODES);

/** The translation key of an API error under errors.codes, or "unknown". */
export function errorCodeOf(error: unknown): ErrorCode | 'unknown' {
  if (error instanceof ApiError && KNOWN_CODES.has(error.code)) {
    return error.code as ErrorCode;
  }
  return 'unknown';
}
