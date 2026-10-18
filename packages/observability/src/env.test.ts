import { describe, expect, it } from 'vitest';

import { checkProductionEnv, isLoopbackUrl, observabilityEnvSchema } from './env';

describe('observabilityEnvSchema', () => {
  it('applies defaults when the optional values are missing', () => {
    const env = observabilityEnvSchema.parse({});

    expect(env).toEqual({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
  });

  it('treats empty optional values as unset', () => {
    const env = observabilityEnvSchema.parse({ OTEL_EXPORTER_OTLP_ENDPOINT: '', SENTRY_DSN: '' });

    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('rejects a malformed collector endpoint without echoing it', () => {
    const endpoint = 'not a url 4c1d9e';

    const result = observabilityEnvSchema.safeParse({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(endpoint);
  });
});

describe('the rules of production', () => {
  const issuesOf = (env: Record<string, unknown> & { NODE_ENV: string; APP_URL?: string }, urls = {}) => {
    const issues: { path: string[]; message: string }[] = [];
    checkProductionEnv(env, { addIssue: (issue) => issues.push(issue) }, urls);
    return issues;
  };

  it('knows the URLs of this machine', () => {
    expect(isLoopbackUrl('http://localhost:8080')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:3000/')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000')).toBe(true);
    expect(isLoopbackUrl('https://app.example.com')).toBe(false);
    expect(isLoopbackUrl('http://localhost.example.com')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });

  it('needs https and refuses the example values of .env.example, without echoing them', () => {
    const env = {
      NODE_ENV: 'production',
      APP_URL: 'http://app.example.com',
      DATABASE_URL: 'postgresql://app_user:change-me-app-user@db:5432/smp',
      S3_SECRET_ACCESS_KEY: 'smp-local-secret-key',
    };

    const issues = issuesOf(env, { APP_URL: env.APP_URL, S3_ENDPOINT: 'https://s3.example.com' });

    expect(issues).toEqual([
      { code: 'custom', path: ['APP_URL'], message: 'an https URL is required in production' },
      {
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'an example value of .env.example is not allowed in production',
      },
      {
        code: 'custom',
        path: ['S3_SECRET_ACCESS_KEY'],
        message: 'an example value of .env.example is not allowed in production',
      },
    ]);
    expect(JSON.stringify(issues)).not.toMatch(/change-me-app-user|smp-local-secret-key/);
  });

  it('leaves development and a production build on this machine alone', () => {
    const local = { APP_URL: 'http://localhost:8080', REDIS_URL: 'redis://app:change-me@redis:6379' };

    expect(issuesOf({ NODE_ENV: 'production', ...local }, { APP_URL: local.APP_URL })).toEqual([]);
    expect(
      issuesOf({ NODE_ENV: 'development', APP_URL: 'http://app.example.com' }, { APP_URL: 'http://x' }),
    ).toEqual([]);
  });
});
