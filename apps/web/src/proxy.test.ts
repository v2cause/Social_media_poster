import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { proxy } from './proxy';

// Every page request gets an ID of its own, in the request Next.js renders and in the response;
// the ID a client sends is replaced (guide step 8.7, ASVS 16.2.1).

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

const request = (path: string, headers: Record<string, string> = {}): NextRequest =>
  new NextRequest(`http://localhost:3000${path}`, { headers });

describe('proxy', () => {
  it('gives a page request an ID of its own in the request and the response', () => {
    const response = proxy(
      request('/w/demo', { cookie: 'smp.session_token=abc', 'x-request-id': 'chosen-by-client' }),
    );

    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(UUID);
    // Next.js hands the changed request headers on as x-middleware-request-*.
    expect(response.headers.get('x-middleware-request-x-request-id')).toBe(requestId);
    expect(
      proxy(request('/w/demo', { cookie: 'smp.session_token=abc' })).headers.get('x-request-id'),
    ).not.toBe(requestId);
  });

  it('names the request ID on the redirect to the sign-in as well', () => {
    const response = proxy(request('/w/demo/posts?status=FAILED'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?next=%2Fw%2Fdemo%2Fposts%3Fstatus%3DFAILED',
    );
    expect(response.headers.get('x-request-id')).toMatch(UUID);
  });
});
