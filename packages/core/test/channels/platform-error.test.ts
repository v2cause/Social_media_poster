import { describe, expect, it } from 'vitest';

import { isPlatformError, PlatformError } from '../../src';

// The error taxonomy of the adapters (architecture 4.1).

describe('PlatformError', () => {
  it('knows which codes are worth another try', () => {
    expect(new PlatformError('TRANSIENT', 'x').retryable).toBe(true);
    expect(new PlatformError('RATE_LIMITED', 'x', { retryAfterMs: 1_000 })).toMatchObject({
      retryable: true,
      retryAfterMs: 1_000,
    });
    expect(new PlatformError('AUTH_EXPIRED', 'x').retryable).toBe(false);
    expect(new PlatformError('OUTCOME_UNKNOWN', 'x').retryable).toBe(false);
    expect(new PlatformError('VALIDATION_REJECTED', 'x', { retryable: true }).retryable).toBe(true);
  });

  it('recognizes its errors without instanceof, also from a second copy of the module', () => {
    const copy = Object.assign(new Error('copy'), {
      [Symbol.for('smp.PlatformError')]: true,
      code: 'TRANSIENT',
    });

    expect(isPlatformError(new PlatformError('DUPLICATE', 'x'))).toBe(true);
    expect(isPlatformError(copy)).toBe(true);
    expect(isPlatformError(new Error('plain'))).toBe(false);
    expect(isPlatformError(null)).toBe(false);
  });
});
