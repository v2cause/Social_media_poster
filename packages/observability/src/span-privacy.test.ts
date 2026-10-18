import { describe, expect, it } from 'vitest';

import { instrumentationConfig } from './otel';
import {
  fetchSpanAttributes,
  incomingSpanAttributes,
  outgoingSpanAttributes,
  privatePath,
  redisStatement,
} from './span-privacy';

// Guide step 8.4: spans carry neither the tokens of links nor personal data.

describe('span privacy', () => {
  it('keeps the path without query and masks the token of a reset link', () => {
    expect(privatePath('/api/w/acme/posts?status=DRAFT#top')).toBe('/api/w/acme/posts');
    expect(privatePath('/api/auth/reset-password/8m2VhQ0x?callbackURL=%2Freset')).toBe(
      '/api/auth/reset-password/REDACTED',
    );
    expect(privatePath('/api/auth/reset-password/')).toBe('/api/auth/reset-password/');
    expect(privatePath(undefined)).toBeUndefined();
  });

  it('drops query, client address and user agent of server spans', () => {
    expect(incomingSpanAttributes({ url: '/api/auth/verify-email?token=eyJhbGci' })).toEqual({
      'url.path': '/api/auth/verify-email',
      'url.query': undefined,
      'client.address': undefined,
      'network.peer.address': undefined,
      'network.peer.port': undefined,
      'user_agent.original': undefined,
    });
  });

  it('keeps the full URL of client spans without its query', () => {
    expect(
      outgoingSpanAttributes({
        protocol: 'https:',
        hostname: 'api.stripe.com',
        port: 443,
        path: '/v1/x?key=1',
      }),
    ).toEqual({ 'url.full': 'https://api.stripe.com:443/v1/x' });
    expect(outgoingSpanAttributes({ host: 'seaweedfs', path: '/bucket/key' })).toEqual({
      'url.full': 'http://seaweedfs/bucket/key',
    });
    expect(
      fetchSpanAttributes({ origin: 'https://graph.example.test', path: '/v21.0/me?access_token=secret' }),
    ).toEqual({ 'url.full': 'https://graph.example.test/v21.0/me', 'url.query': undefined });
  });

  it('records Redis commands without their arguments', () => {
    expect(redisStatement('evalsha')).toBe('evalsha');
  });

  it('hands the hooks to the instrumentations', () => {
    const config = instrumentationConfig();

    expect(config['@opentelemetry/instrumentation-http'].startIncomingSpanHook).toBe(incomingSpanAttributes);
    expect(config['@opentelemetry/instrumentation-http'].startOutgoingSpanHook).toBe(outgoingSpanAttributes);
    expect(config['@opentelemetry/instrumentation-undici'].startSpanHook).toBe(fetchSpanAttributes);
    expect(config['@opentelemetry/instrumentation-ioredis'].dbStatementSerializer).toBe(redisStatement);
  });
});
