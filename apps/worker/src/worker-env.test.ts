import { describe, expect, it } from 'vitest';

import { loadWorkerEnv } from './worker-env';

const validEnv: NodeJS.ProcessEnv = {
  WORKER_ROLES: 'scheduler',
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL: 'postgresql://app_user:secret-user@127.0.0.1:5432/smp',
};

describe('loadWorkerEnv', () => {
  it('applies the defaults and leaves the role-specific settings optional', () => {
    const env = loadWorkerEnv(validEnv);

    expect(env.SCHEDULER_TICK_MS).toBe(15_000);
    expect(env.WORKER_HEALTH_PORT).toBe(3002);
    expect(env.DATABASE_SYSTEM_URL).toBeUndefined();
    expect(env.TOKEN_KEKS).toBeUndefined();
  });

  it('reads numeric settings from their string form', () => {
    const env = loadWorkerEnv({ ...validEnv, SCHEDULER_TICK_MS: '2000', WORKER_HEALTH_PORT: '4100' });

    expect(env.SCHEDULER_TICK_MS).toBe(2_000);
    expect(env.WORKER_HEALTH_PORT).toBe(4_100);
  });

  it('names a missing or broken variable without printing values', () => {
    const withoutRedis = { ...validEnv, REDIS_URL: undefined };
    const brokenSystemUrl = { ...validEnv, DATABASE_SYSTEM_URL: 'mysql://app_system:secret-system@db/smp' };

    expect(() => loadWorkerEnv(withoutRedis)).toThrow(/REDIS_URL/);
    expect(() => loadWorkerEnv(withoutRedis)).not.toThrow(/secret-user/);
    expect(() => loadWorkerEnv(brokenSystemUrl)).toThrow(/DATABASE_SYSTEM_URL/);
    expect(() => loadWorkerEnv(brokenSystemUrl)).not.toThrow(/secret-system/);
  });
});
