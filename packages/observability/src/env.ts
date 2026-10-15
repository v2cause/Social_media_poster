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
