import { APIConnectionError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { failureFromError } from './map-result';

// A failed connection names the code Node gives it, so that a refused certificate shows in the
// log as such (ASVS 16.3.4); nothing else of the cause reaches the detail.

const fetchFailed = (code: unknown): Error =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket'), { code }) });

describe('failureFromError', () => {
  it('names the code of a failed connection', () => {
    expect(
      failureFromError(new APIConnectionError({ cause: fetchFailed('CERT_HAS_EXPIRED') }), false),
    ).toEqual({
      code: 'PROVIDER_ERROR',
      retryable: true,
      detail: 'connection failed: APIConnectionError (CERT_HAS_EXPIRED)',
      refusalCategory: null,
      status: null,
    });
    expect(
      failureFromError(new APIConnectionError({ cause: fetchFailed('ECONNRESET') }), false),
    ).toMatchObject({
      detail: 'connection failed: APIConnectionError (ECONNRESET)',
    });
  });

  it('keeps the class alone without a code or with one that is no code', () => {
    expect(failureFromError(new APIConnectionTimeoutError(), false)).toMatchObject({
      detail: 'connection failed: APIConnectionTimeoutError',
      retryable: true,
    });
    expect(
      failureFromError(
        new APIConnectionError({ cause: fetchFailed('see https://example.test/?key=1') }),
        false,
      ),
    ).toMatchObject({ detail: 'connection failed: APIConnectionError' });
  });
});
