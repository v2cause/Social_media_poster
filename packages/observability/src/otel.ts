import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import {
  fetchSpanAttributes,
  incomingSpanAttributes,
  outgoingSpanAttributes,
  redisStatement,
} from './span-privacy';

export interface TracingOptions {
  serviceName: string;
  environment: string;
  /** Base URL of an OTLP/HTTP collector. Without it, tracing stays off. */
  otlpEndpoint?: string;
}

const INSTRUMENTATIONS = {
  // Filesystem and DNS calls create so many spans that they drown out the request traces.
  '@opentelemetry/instrumentation-fs': { enabled: false },
  '@opentelemetry/instrumentation-dns': { enabled: false },
  // No secrets and no personal data in spans (./span-privacy).
  '@opentelemetry/instrumentation-http': {
    startIncomingSpanHook: incomingSpanAttributes,
    startOutgoingSpanHook: outgoingSpanAttributes,
  },
  '@opentelemetry/instrumentation-undici': { startSpanHook: fetchSpanAttributes },
  '@opentelemetry/instrumentation-ioredis': { dbStatementSerializer: redisStatement },
};

/** The configuration of the instrumentations, for tests. */
export const instrumentationConfig = (): typeof INSTRUMENTATIONS => INSTRUMENTATIONS;

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
    instrumentations: [getNodeAutoInstrumentations(INSTRUMENTATIONS)],
  });
  sdk.start();
  return sdk;
}
