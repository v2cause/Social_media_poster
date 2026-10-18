import { z } from 'zod';

// Compose and .env.example set empty strings for optional values. Treat them as unset.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const observabilityEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: optional(z.url()),
  SENTRY_DSN: optional(z.url()),
});

export type ObservabilityEnv = z.infer<typeof observabilityEnvSchema>;

interface IssueSink {
  addIssue(issue: { code: 'custom'; path: string[]; message: string }): void;
}

/** A URL on this machine: localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** Every example value of .env.example contains it. */
const EXAMPLE_VALUE = 'change-me';

/**
 * The rules of production (guide step 8.4), for superRefine: the browser and the recipients of
 * emails get https URLs only, and no value of .env.example runs. A production build on this
 * machine, as the compose profile "app" starts it with APP_URL on localhost, keeps both.
 */
export function checkProductionEnv(
  env: Record<string, unknown> & { NODE_ENV: string; APP_URL?: string | undefined },
  ctx: IssueSink,
  publicUrls: Record<string, string | undefined>,
): void {
  if (env.NODE_ENV !== 'production' || isLoopbackUrl(env.APP_URL)) {
    return;
  }
  for (const [name, url] of Object.entries(publicUrls)) {
    if (url !== undefined && !url.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: [name], message: 'an https URL is required in production' });
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.includes(EXAMPLE_VALUE)) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: 'an example value of .env.example is not allowed in production',
      });
    }
  }
}
