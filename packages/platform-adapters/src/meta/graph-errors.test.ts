import { PlatformError } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { endsBatch, isMissingObject, metaErrorMapper } from './graph-errors';

const map = metaErrorMapper('test.call');

const answer = (
  code: number,
  subcode?: number,
  extra: Record<string, unknown> = {},
  headers = new Headers(),
) =>
  map({
    status: 400,
    headers,
    body: {
      error: {
        message: 'Error validating access token: the token contains EAAB-secret',
        type: 'OAuthException',
        code,
        ...(subcode === undefined ? {} : { error_subcode: subcode }),
        fbtrace_id: 'A1',
        ...extra,
      },
    },
  });

describe('metaErrorMapper', () => {
  it.each([
    [190, undefined, 'AUTH_EXPIRED'],
    [190, 463, 'AUTH_EXPIRED'],
    [102, undefined, 'AUTH_EXPIRED'],
    [100, 460, 'AUTH_EXPIRED'],
    [190, 492, 'PERMISSION_DENIED'],
    [10, undefined, 'PERMISSION_DENIED'],
    [200, undefined, 'PERMISSION_DENIED'],
    [299, undefined, 'PERMISSION_DENIED'],
    [4, 2207051, 'PERMISSION_DENIED'],
    [25, 2207050, 'PERMISSION_DENIED'],
    [4, undefined, 'RATE_LIMITED'],
    [17, undefined, 'RATE_LIMITED'],
    [32, undefined, 'RATE_LIMITED'],
    [613, undefined, 'RATE_LIMITED'],
    [80001, undefined, 'RATE_LIMITED'],
    [80002, undefined, 'RATE_LIMITED'],
    [9, 2207042, 'RATE_LIMITED'],
    [368, undefined, 'RATE_LIMITED'],
    [506, undefined, 'DUPLICATE'],
    [9007, 2207027, 'MEDIA_PROCESSING'],
    [9004, 2207052, 'VALIDATION_REJECTED'],
    [36003, 2207009, 'VALIDATION_REJECTED'],
    [-2, 2207003, 'TRANSIENT'],
    [24, 2207008, 'TRANSIENT'],
    [1, undefined, 'TRANSIENT'],
    [2, undefined, 'TRANSIENT'],
  ] as const)('maps Graph error %s/%s to %s', (code, subcode, expected) => {
    const error = answer(code, subcode);
    expect(error?.code).toBe(expected);
    expect(error?.platformCode).toBe(
      subcode === undefined ? String(code) : `${String(code)}/${String(subcode)}`,
    );
  });

  it('never copies the message of Meta into the error', () => {
    expect(answer(190)?.message).not.toContain('EAAB');
    expect(answer(190)?.message).toContain('Graph error 190');
  });

  it('takes the wait of X-Business-Use-Case-Usage for rate limits', () => {
    const headers = new Headers({
      'x-business-use-case-usage': JSON.stringify({
        '200000000000001': [{ type: 'pages', call_count: 100, estimated_time_to_regain_access: 19 }],
      }),
    });
    expect(answer(80001, undefined, {}, headers)?.retryAfterMs).toBe(19 * 60_000);
    expect(answer(4)?.retryAfterMs).toBe(60_000);
    expect(answer(9, 2207042)?.retryAfterMs).toBe(3_600_000);
  });

  it('treats is_transient as transient and leaves unknown codes to the HTTP status', () => {
    expect(answer(12345, undefined, { is_transient: true })?.code).toBe('TRANSIENT');
    expect(answer(100)).toBeUndefined();
    expect(map({ status: 500, headers: new Headers(), body: 'oops' })).toBeUndefined();
  });

  it('recognizes a deleted object', () => {
    expect(isMissingObject(answer(100, 33))).toBe(true);
    expect(isMissingObject(new PlatformError('VALIDATION_REJECTED', 'gone', { status: 404 }))).toBe(true);
    expect(isMissingObject(answer(100))).toBe(false);
    expect(endsBatch(answer(190))).toBe(true);
    expect(endsBatch(answer(1))).toBe(false);
  });
});
