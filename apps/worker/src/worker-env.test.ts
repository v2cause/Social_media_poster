import { describe, expect, it } from 'vitest';

import { loadWorkerEnv } from './worker-env';

const validEnv: NodeJS.ProcessEnv = {
  WORKER_ROLES: 'scheduler',
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL: 'postgresql://app_user:secret-user@127.0.0.1:5432/smp',
};

describe('loadWorkerEnv', () => {
  it('applies the defaults for the tick interval and the health port', () => {
    const env = loadWorkerEnv(validEnv);

    expect(env.SCHEDULER_TICK_MS).toBe(60_000);
    expect(env.WORKER_HEALTH_PORT).toBe(3002);
  });

  it('reads numeric settings from their string form', () => {
    const env = loadWorkerEnv({ ...validEnv, SCHEDULER_TICK_MS: '5000', WORKER_HEALTH_PORT: '4100' });

    expect(env.SCHEDULER_TICK_MS).toBe(5_000);
    expect(env.WORKER_HEALTH_PORT).toBe(4_100);
  });

  it('names a missing variable without printing values', () => {
    const withoutRedis = { ...validEnv, REDIS_URL: undefined };

    expect(() => loadWorkerEnv(withoutRedis)).toThrow(/REDIS_URL/);
    expect(() => loadWorkerEnv(withoutRedis)).not.toThrow(/secret-user/);
  });
});
