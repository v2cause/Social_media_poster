import { trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger } from 'pino';

import { currentLogContext } from './log-context';
import { redactSecrets } from './redact';

export interface LoggerOptions {
  service: string;
  environment: string;
  level?: pino.LevelWithSilent;
  /** Defaults to stdout. Tests pass an in-memory stream. */
  destination?: DestinationStream;
}

export function createLogger({ service, environment, level = 'info', destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service, env: environment },
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: () => {
        const traceId = trace.getActiveSpan()?.spanContext().traceId;
        return traceId ? { ...currentLogContext(), traceId } : { ...currentLogContext() };
      },
      formatters: {
        log: (object) => redactSecrets(object) as Record<string, unknown>,
      },
    },
    destination,
  );
}

export type { Logger } from 'pino';
