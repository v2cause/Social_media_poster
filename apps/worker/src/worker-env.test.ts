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

  it('applies the defaults of the publisher', () => {
    expect(loadWorkerEnv(validEnv)).toMatchObject({
      PUBLISH_CONCURRENCY: 5,
      PUBLISH_LOCK_MS: 30_000,
      PUBLISH_LEASE_MS: 300_000,
      PLATFORM_MODE_LINKEDIN: 'mock',
      PLATFORM_MODE_META: 'mock',
      PLATFORM_MODE_X: 'mock',
      PUBLISH_DRY_RUN: false,
    });
  });

  it('reads numeric settings from their string form', () => {
    const env = loadWorkerEnv({ ...validEnv, SCHEDULER_TICK_MS: '2000', WORKER_HEALTH_PORT: '4100' });

    expect(env.SCHEDULER_TICK_MS).toBe(2_000);
    expect(env.WORKER_HEALTH_PORT).toBe(4_100);
    // Any free port, for the integration tests.
    expect(loadWorkerEnv({ ...validEnv, WORKER_HEALTH_PORT: '0' }).WORKER_HEALTH_PORT).toBe(0);
  });

  it('names a missing or broken variable without printing values', () => {
    const withoutRedis = { ...validEnv, REDIS_URL: undefined };
    const brokenSystemUrl = { ...validEnv, DATABASE_SYSTEM_URL: 'mysql://app_system:secret-system@db/smp' };

    expect(() => loadWorkerEnv(withoutRedis)).toThrow(/REDIS_URL/);
    expect(() => loadWorkerEnv(withoutRedis)).not.toThrow(/secret-user/);
    expect(() => loadWorkerEnv(brokenSystemUrl)).toThrow(/DATABASE_SYSTEM_URL/);
    expect(() => loadWorkerEnv(brokenSystemUrl)).not.toThrow(/secret-system/);
  });

  it('takes the Stripe API base of the fake with test keys only, and never in production', () => {
    const fake = {
      ...validEnv,
      STRIPE_SECRET_KEY: 'sk_test_worker',
      STRIPE_API_BASE: 'http://127.0.0.1:12111',
    };

    expect(loadWorkerEnv(fake)).toMatchObject({ STRIPE_API_BASE: 'http://127.0.0.1:12111' });
    expect(() => loadWorkerEnv({ ...fake, STRIPE_SECRET_KEY: 'sk_live_worker' })).toThrow(
      /STRIPE_SECRET_KEY: STRIPE_API_BASE takes test keys only/,
    );
    expect(() => loadWorkerEnv({ ...fake, NODE_ENV: 'production' })).toThrow(/STRIPE_API_BASE/);
    expect(() => loadWorkerEnv({ ...validEnv, STRIPE_SECRET_KEY: 'pk_test_public' })).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    expect(() => loadWorkerEnv({ ...validEnv, STRIPE_SECRET_KEY: 'pk_test_public' })).not.toThrow(
      /pk_test_public/,
    );
  });
});

describe('loadWorkerEnv in production (guide step 8.4)', () => {
  const deployed = {
    ...validEnv,
    NODE_ENV: 'production',
    APP_URL: 'https://app.example.com',
    SMTP_URL: 'smtp://mail.example.com:587',
    MAIL_FROM: 'noreply@example.com',
  };

  it('needs https for the links of the emails and refuses example values', () => {
    expect(loadWorkerEnv(deployed).APP_URL).toBe('https://app.example.com');
    expect(() => loadWorkerEnv({ ...deployed, APP_URL: 'http://app.example.com' })).toThrow(
      /APP_URL: an https URL is required in production/,
    );
    expect(() =>
      loadWorkerEnv({ ...deployed, REDIS_URL: 'redis://app:change-me-redis-app@redis:6379' }),
    ).toThrow(/REDIS_URL: an example value of .env.example is not allowed in production/);
  });

  it('lets a production build on this machine keep the example values', () => {
    const local = {
      ...deployed,
      APP_URL: 'http://localhost:3000',
      REDIS_URL: 'redis://app:change-me@redis:6379',
    };

    expect(loadWorkerEnv(local).REDIS_URL).toBe('redis://app:change-me@redis:6379');
  });
});
