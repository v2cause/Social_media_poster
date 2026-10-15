import { describe, expect, it } from 'vitest';

import { loadBrowserWorkerEnv } from './env';

describe('loadBrowserWorkerEnv', () => {
  it('keeps the X browser adapter switched off by default', () => {
    const env = loadBrowserWorkerEnv({ REDIS_URL: 'redis://127.0.0.1:6379' });

    expect(env.FEATURE_X_BROWSER_GLOBAL).toBe(false);
  });

  it('reads the kill switch from its string form', () => {
    const env = loadBrowserWorkerEnv({
      REDIS_URL: 'redis://127.0.0.1:6379',
      FEATURE_X_BROWSER_GLOBAL: 'true',
    });

    expect(env.FEATURE_X_BROWSER_GLOBAL).toBe(true);
  });

  it('requires Redis and names it when missing', () => {
    expect(() => loadBrowserWorkerEnv({})).toThrow(/REDIS_URL/);
  });
});
