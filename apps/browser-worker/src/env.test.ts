import { describe, expect, it } from 'vitest';

import { loadBrowserWorkerEnv } from './env';

const KEYS = { SESSION_KEKS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', SESSION_KEK_ACTIVE: 'k1' };

describe('loadBrowserWorkerEnv', () => {
  it('keeps the X browser adapter switched off by default', () => {
    const env = loadBrowserWorkerEnv({ REDIS_URL: 'redis://127.0.0.1:6379' });

    expect(env.FEATURE_X_BROWSER_GLOBAL).toBe(false);
    expect(env.XB_CONCURRENCY).toBe(1);
    expect(env.XB_EGRESS_HOSTS).toEqual([]);
    expect(env.XB_EGRESS_PROXY).toBeUndefined();
  });

  it('reads the kill switch from its string form and then needs the session keyring', () => {
    const on = { REDIS_URL: 'redis://127.0.0.1:6379', FEATURE_X_BROWSER_GLOBAL: 'true' };
    expect(() => loadBrowserWorkerEnv(on)).toThrow(/SESSION_KEKS/);
    expect(() => loadBrowserWorkerEnv({ ...on, SESSION_KEKS: '', SESSION_KEK_ACTIVE: '' })).toThrow(
      /SESSION_KEKS/,
    );

    const env = loadBrowserWorkerEnv({ ...on, ...KEYS });
    expect(env.FEATURE_X_BROWSER_GLOBAL).toBe(true);
  });

  it('reads the origins of the media storage and the egress proxy', () => {
    const env = loadBrowserWorkerEnv({
      REDIS_URL: 'redis://127.0.0.1:6379',
      XB_EGRESS_HOSTS: 'http://s3:8333, https://media.example.com',
      XB_EGRESS_PROXY: 'http://egress-proxy:3128',
      XB_CONCURRENCY: '2',
    });

    expect(env.XB_EGRESS_HOSTS).toEqual(['http://s3:8333', 'https://media.example.com']);
    expect(env.XB_EGRESS_PROXY).toBe('http://egress-proxy:3128');
    expect(env.XB_CONCURRENCY).toBe(2);
  });

  it('refuses an egress entry it cannot read and more than two commands at a time', () => {
    const base = { REDIS_URL: 'redis://127.0.0.1:6379' };
    expect(() =>
      loadBrowserWorkerEnv({ ...base, XB_EGRESS_HOSTS: 'https://media.example.com/path' }),
    ).toThrow(/XB_EGRESS_HOSTS/);
    expect(() => loadBrowserWorkerEnv({ ...base, XB_CONCURRENCY: '3' })).toThrow(/XB_CONCURRENCY/);
  });

  it('requires Redis and names it when missing', () => {
    expect(() => loadBrowserWorkerEnv({})).toThrow(/REDIS_URL/);
  });
});
