import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

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

describe('loadApiEnv with secrets as files (guide step 8.9)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-api-env-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a secret from the file that <NAME>_FILE names', () => {
    const path = join(dir, 'database-url');
    writeFileSync(path, 'postgresql://app_user:from-file@postgres:5432/smp\n');

    const env = loadApiEnv({ ...validEnv, DATABASE_URL: undefined, DATABASE_URL_FILE: path });

    expect(env.DATABASE_URL).toBe('postgresql://app_user:from-file@postgres:5432/smp');
  });
});

describe('loadApiEnv with the keyring of the e-mail jobs (guide step 8.9)', () => {
  it('takes it from its variables and leaves it out when they are empty', () => {
    const env = loadApiEnv({ ...validEnv, NOTIFY_KEKS: 'ntf-1:a2V5', NOTIFY_KEK_ACTIVE: 'ntf-1' });

    expect(env).toMatchObject({ NOTIFY_KEKS: 'ntf-1:a2V5', NOTIFY_KEK_ACTIVE: 'ntf-1' });
    expect(loadApiEnv({ ...validEnv, NOTIFY_KEKS: '', NOTIFY_KEK_ACTIVE: '' }).NOTIFY_KEKS).toBeUndefined();
  });
});

describe('loadApiEnv behind the egress proxy (guide step 8.9)', () => {
  it('needs the proxy once Node sends its connections through it', () => {
    const env = loadApiEnv({
      ...validEnv,
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://egress:3128',
      NO_PROXY: 'postgres,redis,s3',
    });

    expect(env).toMatchObject({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://egress:3128' });
    expect(() => loadApiEnv({ ...validEnv, NODE_USE_ENV_PROXY: '1' })).toThrow(/HTTPS_PROXY/);
    expect(() => loadApiEnv({ ...validEnv, NODE_USE_ENV_PROXY: 'true' })).toThrow(/NODE_USE_ENV_PROXY/);
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

describe('loadApiEnv in production (guide step 8.4)', () => {
  const deployed = {
    ...validEnv,
    NODE_ENV: 'production',
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    PWNED_PASSWORDS_API_URL: 'https://api.pwnedpasswords.com',
    APP_URL: 'https://app.example.com',
    BETTER_AUTH_URL: 'https://app.example.com',
    S3_ENDPOINT: 'http://s3:8333',
    S3_PUBLIC_ENDPOINT: 'https://media.example.com',
  };

  it('starts with https for the browser and its own secrets', () => {
    expect(loadApiEnv(deployed).APP_URL).toBe('https://app.example.com');
  });

  it('needs https for the app, its links and the uploads', () => {
    expect(() => loadApiEnv({ ...deployed, BETTER_AUTH_URL: 'http://app.example.com' })).toThrow(
      /BETTER_AUTH_URL: an https URL is required in production/,
    );
    expect(() => loadApiEnv({ ...deployed, S3_PUBLIC_ENDPOINT: 'http://media.example.com' })).toThrow(
      /S3_PUBLIC_ENDPOINT: an https URL is required/,
    );
    expect(() => loadApiEnv({ ...deployed, S3_PUBLIC_ENDPOINT: '' })).toThrow(
      /S3_ENDPOINT: an https URL is required/,
    );
  });

  it('refuses the example values of .env.example without echoing them', () => {
    const example = 'postgresql://app_user:change-me-app-user@db:5432/smp';
    let message = '';
    try {
      loadApiEnv({ ...deployed, DATABASE_URL: example });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('DATABASE_URL: an example value of .env.example is not allowed in production');
    expect(message).not.toContain('change-me-app-user');
  });

  it('lets a production build on this machine keep http and the example values', () => {
    const local = {
      ...deployed,
      APP_URL: 'http://localhost:8080',
      BETTER_AUTH_URL: 'http://localhost:8080',
      S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:8333',
      DATABASE_URL: 'postgresql://app_user:change-me-app-user@postgres:5432/smp',
    };

    expect(loadApiEnv(local).APP_URL).toBe('http://localhost:8080');
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
