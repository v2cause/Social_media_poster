import { describe, expect, it } from 'vitest';

import { graphErrorOf, isNotFound } from './graph-api';

// Guide step 4.13: the error codes of the Graph API in the error taxonomy.

const answer = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) => ({
  status,
  headers: new Headers(headers),
  body: { error: { message: 'failure', ...error } },
});

const map = graphErrorOf('meta.test');

describe('graphErrorOf', () => {
  it.each([
    [400, { code: 190, error_subcode: 463 }, 'AUTH_EXPIRED'],
    [400, { code: 102 }, 'AUTH_EXPIRED'],
    [400, { code: 10 }, 'PERMISSION_DENIED'],
    [403, { code: 200 }, 'PERMISSION_DENIED'],
    [400, { code: 368 }, 'PERMISSION_DENIED'],
    [400, { code: 506 }, 'DUPLICATE'],
    [400, { code: 4 }, 'RATE_LIMITED'],
    [400, { code: 32 }, 'RATE_LIMITED'],
    [400, { code: 80001 }, 'RATE_LIMITED'],
    [400, { code: 9007, error_subcode: 2207027 }, 'MEDIA_PROCESSING'],
    [400, { code: 9004, error_subcode: 2207052 }, 'VALIDATION_REJECTED'],
    [500, { code: 2 }, 'TRANSIENT'],
    [400, { code: 1, is_transient: true }, 'TRANSIENT'],
  ])('maps HTTP %i with %o to %s', (status, error, code) => {
    expect(map(answer(status, error))?.code).toBe(code);
  });

  it('names the code and subcode of the platform, never the message', () => {
    const failure = map(
      answer(400, { code: 190, error_subcode: 460, message: 'token secret-value expired' }),
    );
    expect(failure).toMatchObject({ platformCode: '190/460', status: 400 });
    expect(failure?.message).not.toContain('secret-value');
  });

  it('takes the wait of a rate limit from the business use case header', () => {
    const usage = JSON.stringify({ '1100200300': [{ type: 'pages', estimated_time_to_regain_access: 5 }] });
    expect(map(answer(400, { code: 32 }, { 'x-business-use-case-usage': usage }))?.retryAfterMs).toBe(
      300_000,
    );
  });

  it('marks an object that does not exist as not found', () => {
    expect(isNotFound(map(answer(400, { code: 100, error_subcode: 33 })))).toBe(true);
    expect(isNotFound(map(answer(400, { code: 100 })))).toBe(false);
  });

  it('leaves answers without a Graph error to the generic mapping', () => {
    expect(map({ status: 502, headers: new Headers(), body: '<html>bad gateway</html>' })).toBeUndefined();
  });
});
