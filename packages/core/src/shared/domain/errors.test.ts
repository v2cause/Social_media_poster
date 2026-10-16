import { describe, expect, it } from 'vitest';

import { isDomainError, NotPermittedError } from './errors';

describe('isDomainError', () => {
  it('recognizes domain errors by their brand, not by class identity', () => {
    expect(isDomainError(new NotPermittedError())).toBe(true);
    const copy = Object.assign(new Error('copy'), { [Symbol.for('smp.domain-error')]: true });
    expect(isDomainError(copy)).toBe(true);
    expect(isDomainError(new Error('plain'))).toBe(false);
    expect(isDomainError({ code: 'X', kind: 'invalid' })).toBe(false);
  });
});
