import { describe, expect, it } from 'vitest';

import { scrubRequestHeaders } from './sentry';

describe('scrubRequestHeaders', () => {
  it('removes credential headers regardless of their case', () => {
    const headers = {
      Authorization: 'Bearer abc',
      Cookie: 'session=xyz',
      'set-cookie': 'session=new',
      'user-agent': 'vitest',
    };

    expect(scrubRequestHeaders(headers)).toEqual({ 'user-agent': 'vitest' });
  });
});
