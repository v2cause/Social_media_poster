// Side-effect entry point. Load it first, before any application module:
//   node --require @smp/observability/register dist/main.js
// Configuration comes from the environment, validated with zod. Invalid values stop the start.
import { observabilityEnvSchema } from './env';
import { startErrorReporting } from './sentry';
import { startTracing } from './otel';

const env = observabilityEnvSchema.parse(process.env);

startTracing({
  serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'social-media-poster',
  environment: env.NODE_ENV,
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
});
startErrorReporting({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
