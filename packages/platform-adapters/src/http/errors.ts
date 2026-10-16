import { PlatformError } from '@smp/core';

import { retryAfterMsOf } from './rate-headers';

// The generic mapping of HTTP answers to the error taxonomy (architecture 4.1 and 7.1). Adapters
// map platform-specific answers first (duplicate content at X, error 190 at Meta) and fall back
// to this. The mock adapter uses the same mapping, so the contract suite holds both to it.

/** The wait after a 429 without any hint, for example from LinkedIn. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

export function platformErrorOf(
  response: { status: number; headers: Headers },
  operation: string,
  now = Date.now(),
): PlatformError {
  const { status, headers } = response;
  const message = `${operation} failed with HTTP ${String(status)}`;
  if (status === 401) {
    return new PlatformError('AUTH_EXPIRED', message, { status });
  }
  if (status === 403) {
    return new PlatformError('PERMISSION_DENIED', message, { status });
  }
  if (status === 429) {
    return new PlatformError('RATE_LIMITED', message, {
      status,
      retryAfterMs: retryAfterMsOf(headers, now) ?? DEFAULT_RATE_LIMIT_WAIT_MS,
    });
  }
  if (status === 409) {
    return new PlatformError('DUPLICATE', message, { status });
  }
  if (status >= 500) {
    return new PlatformError('TRANSIENT', message, { status, retryAfterMs: retryAfterMsOf(headers, now) });
  }
  return new PlatformError('VALIDATION_REJECTED', message, { status });
}
