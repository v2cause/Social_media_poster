import { ERROR_CODES } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import de from '../../messages/de/errors.json';
import en from '../../messages/en/errors.json';

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
