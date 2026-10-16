import { describe, expect, it } from 'vitest';

import { platformErrorOf } from './errors';
import { retryAfterMsOf } from './rate-headers';

// The waits the platforms ask for (architecture 4.1).

const now = Date.parse('2026-10-16T10:00:00Z');

describe('retryAfterMsOf', () => {
  it('reads Retry-After in seconds and as a date, the X reset and the Meta usage header', () => {
    expect(retryAfterMsOf(new Headers({ 'retry-after': '120' }), now)).toBe(120_000);
    expect(retryAfterMsOf(new Headers({ 'retry-after': 'Fri, 16 Oct 2026 10:01:30 GMT' }), now)).toBe(90_000);
    expect(retryAfterMsOf(new Headers({ 'x-rate-limit-reset': String(now / 1000 + 300) }), now)).toBe(
      300_000,
    );
    const usage = JSON.stringify({
      '123': [{ type: 'pages', call_count: 100, estimated_time_to_regain_access: 7 }],
    });
    expect(retryAfterMsOf(new Headers({ 'x-business-use-case-usage': usage }), now)).toBe(420_000);
  });

  it('takes the longest wait and ignores what it cannot read', () => {
    expect(
      retryAfterMsOf(
        new Headers({ 'retry-after': '10', 'x-rate-limit-reset': String(now / 1000 + 60) }),
        now,
      ),
    ).toBe(60_000);
    expect(
      retryAfterMsOf(new Headers({ 'retry-after': 'soon', 'x-business-use-case-usage': '{oops' }), now),
    ).toBeUndefined();
    expect(retryAfterMsOf(new Headers(), now)).toBeUndefined();
  });

  it('falls back to a minute for a 429 without a hint, as LinkedIn sends it', () => {
    expect(
      platformErrorOf({ status: 429, headers: new Headers() }, 'linkedin.posts.create', now),
    ).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 60_000,
    });
    expect(platformErrorOf({ status: 422, headers: new Headers() }, 'x', now).code).toBe(
      'VALIDATION_REJECTED',
    );
    expect(platformErrorOf({ status: 409, headers: new Headers() }, 'x', now).code).toBe('DUPLICATE');
  });
});
