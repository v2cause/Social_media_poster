import { describe, expect, it } from 'vitest';

import { observabilityEnvSchema } from './env';

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
