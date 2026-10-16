import { describe, expect, it } from 'vitest';

import { httpLogSerializers, pathOnly } from './http-log-serializers';

describe('pathOnly', () => {
  it('drops the query string and the fragment', () => {
    expect(pathOnly('/api/oauth/x/callback?code=secret&state=abc')).toBe('/api/oauth/x/callback');
    expect(pathOnly('/api/w/acme/posts#top')).toBe('/api/w/acme/posts');
    expect(pathOnly('/api/health/live')).toBe('/api/health/live');
    expect(pathOnly(undefined)).toBeUndefined();
  });
});

describe('httpLogSerializers', () => {
  it('keeps only id, method and path of a request', () => {
    const serialized = httpLogSerializers.req({
      id: 'req-1',
      method: 'GET',
      url: '/api/oauth/x/callback?code=secret',
      // Present on the default serialized request, never logged.
      headers: { cookie: 'session=xyz', authorization: 'Bearer abc' },
      remoteAddress: '203.0.113.7',
    } as Parameters<typeof httpLogSerializers.req>[0]);

    expect(serialized).toEqual({ id: 'req-1', method: 'GET', path: '/api/oauth/x/callback' });
  });

  it('keeps only the status code of a response', () => {
    expect(
      httpLogSerializers.res({ statusCode: 200, headers: { 'set-cookie': 'session=new' } } as Parameters<
        typeof httpLogSerializers.res
      >[0]),
    ).toEqual({ statusCode: 200 });
  });
});
