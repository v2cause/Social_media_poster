import { isPlatformError } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { isPublicHost, publicMediaUrl } from './public-media-url';

const signed =
  'http://localhost:8333/smp-media/r/abc.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=f00';

describe('publicMediaUrl', () => {
  it('moves path and query of the signed URL onto the public base URL', () => {
    expect(publicMediaUrl(signed, 'https://media-tunnel.example.com')).toBe(
      'https://media-tunnel.example.com/smp-media/r/abc.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=f00',
    );
    expect(publicMediaUrl(signed, 'https://tunnel.example.com/storage/')).toBe(
      'https://tunnel.example.com/storage/smp-media/r/abc.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=f00',
    );
  });

  it('keeps a public URL as it is when no base URL is set', () => {
    expect(publicMediaUrl('https://cdn.example.com/a.jpg?sig=1', undefined)).toBe(
      'https://cdn.example.com/a.jpg?sig=1',
    );
  });

  it('refuses a local URL without a public base URL, without retries and without the URL in the message', () => {
    let failure: unknown;
    try {
      publicMediaUrl(signed, undefined);
    } catch (error) {
      failure = error;
    }
    expect(isPlatformError(failure) && failure.code).toBe('VALIDATION_REJECTED');
    expect(isPlatformError(failure) && failure.retryable).toBe(false);
    expect((failure as Error).message).toContain('public media base URL');
    expect((failure as Error).message).not.toContain('X-Amz-Signature');
  });

  it('refuses a private public base URL', () => {
    expect(() => publicMediaUrl(signed, 'http://192.168.1.20:8333')).toThrow(/public media base URL/);
  });
});

describe('isPublicHost', () => {
  it.each([
    'localhost',
    'api.localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '[::1]',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    'seaweedfs',
    'nas.local',
    'storage.internal',
  ])('treats %s as not public', (host) => {
    expect(isPublicHost(host)).toBe(false);
  });

  it.each(['cdn.example.com', '8.8.8.8', '172.32.0.1', 'abc.trycloudflare.com', '2a03:2880::1'])(
    'treats %s as public',
    (host) => {
      expect(isPublicHost(host)).toBe(true);
    },
  );
});
