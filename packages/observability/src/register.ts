// Side-effect entry point. Load it first, before any application module:
//   node --require @smp/observability/register dist/main.js
// Configuration comes from the environment, validated with zod. Invalid values stop the start.
import { observabilityEnvSchema } from './env';
import { loadSecretFiles } from './secret-files';
import { startErrorReporting } from './sentry';
import { startTracing } from './otel';

// Secrets that come as files (guide step 8.9) are in the environment before anything reads it.
loadSecretFiles(process.env);
const env = observabilityEnvSchema.parse(process.env);

startTracing({
  serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'social-media-poster',
  environment: env.NODE_ENV,
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
});
startErrorReporting({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
