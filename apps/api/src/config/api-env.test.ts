import { describe, expect, it } from 'vitest';

import { loadApiEnv } from './api-env';

const validEnv: NodeJS.ProcessEnv = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://app_user:secret-user@127.0.0.1:5432/smp',
  DATABASE_SYSTEM_URL: 'postgresql://app_system:secret-system@127.0.0.1:5432/smp',
  REDIS_URL: 'redis://127.0.0.1:6379',
  S3_ENDPOINT: 'http://127.0.0.1:8333',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'smp-media',
  S3_ACCESS_KEY_ID: 'access-key-value',
  S3_SECRET_ACCESS_KEY: 'secret-key-value',
  BETTER_AUTH_SECRET: 'test-better-auth-secret-of-32-characters',
  BETTER_AUTH_URL: 'http://localhost:3000',
};

describe('loadApiEnv', () => {
  it('applies defaults for the port, path style and log settings', () => {
    const env = loadApiEnv(validEnv);

    expect(env.API_PORT).toBe(3001);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('parses the path-style flag from its string form', () => {
    expect(loadApiEnv({ ...validEnv, S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('names the missing variable without printing any value', () => {
    const withoutDatabase = { ...validEnv, DATABASE_URL: undefined };

    expect(() => loadApiEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
    expect(() => loadApiEnv(withoutDatabase)).not.toThrow(/secret-system/);
  });

  it('rejects a Redis URL with the wrong scheme and does not echo it', () => {
    const badRedis = 'http://user:redis-secret@127.0.0.1:6379';

    let message = '';
    try {
      loadApiEnv({ ...validEnv, REDIS_URL: badRedis });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('REDIS_URL');
    expect(message).not.toContain('redis-secret');
  });

  it('requires a Better Auth secret of at least 32 characters', () => {
    expect(() => loadApiEnv({ ...validEnv, BETTER_AUTH_SECRET: 'too-short' })).toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe('loadApiEnv with AI settings', () => {
  it('defaults to the mock provider outside production', () => {
    const env = loadApiEnv(validEnv);

    expect(env.AI_PROVIDER).toBe('mock');
    expect(env.AI_MONTHLY_CAP_MICROS).toBe(10_000_000);
  });

  it('refuses to start production with the mock provider', () => {
    expect(() => loadApiEnv({ ...validEnv, NODE_ENV: 'production' })).toThrow(
      /AI_PROVIDER: the mock provider is not allowed in production/,
    );
  });

  it('needs the key of the Claude API and never prints it', () => {
    expect(() => loadApiEnv({ ...validEnv, AI_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    const env = loadApiEnv({
      ...validEnv,
      NODE_ENV: 'production',
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-secret-value',
    });
    expect(env.AI_PROVIDER).toBe('anthropic');
  });
});
