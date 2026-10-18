import { describe, expect, it } from 'vitest';

import { httpLogSerializers } from './http-log-serializers';

const pathOf = (url: string): unknown => httpLogSerializers.req({ id: 'req-1', method: 'GET', url }).path;

describe('httpLogSerializers', () => {
  it('drops query and fragment and masks the token of the reset link', () => {
    expect(pathOf('/api/oauth/x/callback?code=secret&state=abc')).toBe('/api/oauth/x/callback');
    expect(pathOf('/api/w/acme/posts#top')).toBe('/api/w/acme/posts');
    expect(pathOf('/api/health/live')).toBe('/api/health/live');
    expect(pathOf('/api/auth/reset-password/8m2VhQ0x?callbackURL=%2Freset')).toBe(
      '/api/auth/reset-password/REDACTED',
    );
  });

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
