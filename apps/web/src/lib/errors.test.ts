import { ApiError } from '@smp/api-client';
import { ERROR_CODES } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import de from '../../messages/de/errors.json';
import en from '../../messages/en/errors.json';
import { errorCodeOf } from './errors';

// Every code the API can answer with has a message in both languages, so the UI never falls
// back to the general error for a known case.
describe('error messages', () => {
  it.each([
    ['de', de.codes],
    ['en', en.codes],
  ])('translate every error code in %s', (_language, codes) => {
    const missing = ERROR_CODES.filter((code) => !(code in codes));

    expect(missing).toEqual([]);
  });
});

describe('errorCodeOf', () => {
  it('reads known codes from API errors and from the codes of failed streams', () => {
    expect(errorCodeOf(new ApiError(409, 'VERSION_CONFLICT'))).toBe('VERSION_CONFLICT');
    expect(errorCodeOf('AI_REFUSED')).toBe('AI_REFUSED');
  });

  it('falls back to unknown for everything else', () => {
    expect(errorCodeOf(new ApiError(418, 'TEAPOT'))).toBe('unknown');
    expect(errorCodeOf('NOT_A_CODE')).toBe('unknown');
    expect(errorCodeOf(new TypeError('Failed to fetch'))).toBe('unknown');
  });
});
