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
  TOKEN_KEKS: 'test-kek:c21wLXRlc3Qta2VrLW1hdGVyaWFsLTAwMDAwMDAwMDA=',
  TOKEN_KEK_ACTIVE: 'test-kek',
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
      PWNED_PASSWORDS_API_URL: 'https://api.pwnedpasswords.com',
    });
    expect(env.AI_PROVIDER).toBe('anthropic');
  });

  it('needs the session keyring once the X browser is offered, without printing it', () => {
    expect(() => loadApiEnv({ ...validEnv, FEATURE_X_BROWSER_GLOBAL: 'true' })).toThrow(
      /SESSION_KEKS: SESSION_KEKS and SESSION_KEK_ACTIVE are required/,
    );
    const keys = 'test-session-kek:c21wLXRlc3Qtc2Vzc2lvbi1rZWstbWF0ZXJpYWwtMDA=';
    const env = loadApiEnv({
      ...validEnv,
      FEATURE_X_BROWSER_GLOBAL: 'true',
      SESSION_KEKS: keys,
      SESSION_KEK_ACTIVE: 'test-session-kek',
    });
    expect(env.SESSION_KEKS).toBe(keys);
    expect(loadApiEnv({ ...validEnv, SESSION_KEKS: '' }).SESSION_KEKS).toBeUndefined();
  });

  it('takes the Stripe key only with the secret of the webhooks, and never echoes either', () => {
    const key = 'sk_test_tests';
    expect(() => loadApiEnv({ ...validEnv, STRIPE_SECRET_KEY: key })).toThrow(
      /STRIPE_WEBHOOK_SECRET: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set together/,
    );
    expect(() => loadApiEnv({ ...validEnv, STRIPE_SECRET_KEY: key })).not.toThrow(new RegExp(key));
    const env = loadApiEnv({ ...validEnv, STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: 'whsec_tests' });
    expect(env.STRIPE_SECRET_KEY).toBe(key);
    expect(
      loadApiEnv({ ...validEnv, STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' }).STRIPE_SECRET_KEY,
    ).toBeUndefined();
    expect(() =>
      loadApiEnv({
        ...validEnv,
        NODE_ENV: 'production',
        AI_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-ant-x',
        STRIPE_API_BASE: 'http://127.0.0.1:12111',
      }),
    ).toThrow(/STRIPE_API_BASE: STRIPE_API_BASE is for tests only/);
  });
});

describe('loadApiEnv with the breach check of passwords', () => {
  const production = {
    ...validEnv,
    NODE_ENV: 'production',
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-x',
  };

  it('leaves the check off when the URL is empty, outside production', () => {
    expect(loadApiEnv({ ...validEnv, PWNED_PASSWORDS_API_URL: '' }).PWNED_PASSWORDS_API_URL).toBeUndefined();
  });

  it('needs an https URL of the range API in production', () => {
    expect(() => loadApiEnv(production)).toThrow(/PWNED_PASSWORDS_API_URL: an https URL is required/);
    expect(() => loadApiEnv({ ...production, PWNED_PASSWORDS_API_URL: 'http://range.example' })).toThrow(
      /PWNED_PASSWORDS_API_URL/,
    );
    expect(
      loadApiEnv({ ...production, PWNED_PASSWORDS_API_URL: 'https://api.pwnedpasswords.com' })
        .PWNED_PASSWORDS_API_URL,
    ).toBe('https://api.pwnedpasswords.com');
  });
});

describe('loadApiEnv with versioned keys of Better Auth', () => {
  const current = 'c'.repeat(32);
  const previous = 'p'.repeat(32);

  it('reads the versions with the current key first', () => {
    expect(
      loadApiEnv({ ...validEnv, BETTER_AUTH_SECRETS: `2:${current}, 1:${previous}` }).BETTER_AUTH_SECRETS,
    ).toEqual([
      { version: 2, value: current },
      { version: 1, value: previous },
    ]);
    expect(loadApiEnv({ ...validEnv, BETTER_AUTH_SECRETS: '' }).BETTER_AUTH_SECRETS).toBeUndefined();
  });

  it('refuses malformed entries, short keys and repeated versions without printing a key', () => {
    for (const value of [`two:${current}`, current, `1:${'s'.repeat(31)}`, `1:${current},1:${previous}`]) {
      let message = '';
      try {
        loadApiEnv({ ...validEnv, BETTER_AUTH_SECRETS: value });
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toContain('BETTER_AUTH_SECRETS');
      expect(message).not.toMatch(/ccccc|ppppp|sssss/);
    }
  });
});
