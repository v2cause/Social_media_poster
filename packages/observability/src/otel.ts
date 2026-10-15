import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TracingOptions {
  serviceName: string;
  environment: string;
  /** Base URL of an OTLP/HTTP collector. Without it, tracing stays off. */
  otlpEndpoint?: string;
}

// Filesystem and DNS calls create so many spans that they drown out the request traces.
const NOISY_INSTRUMENTATIONS = {
  '@opentelemetry/instrumentation-fs': { enabled: false },
  '@opentelemetry/instrumentation-dns': { enabled: false },
};

/** Starts the OpenTelemetry SDK. Call it before any other application module is loaded. */
export function startTracing({
  serviceName,
  environment,
  otlpEndpoint,
}: TracingOptions): NodeSDK | undefined {
  if (!otlpEndpoint) {
    return undefined;
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      'deployment.environment.name': environment,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations(NOISY_INSTRUMENTATIONS)],
  });
  sdk.start();
  return sdk;
}
