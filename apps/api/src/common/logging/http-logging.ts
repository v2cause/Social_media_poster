import { logSerializers } from '@smp/observability';
import type { Logger } from 'pino';
import type { Options } from 'pino-http';
import { uuidv7 } from 'uuidv7';

import { httpLogSerializers } from './http-log-serializers';

// The request line of every request (guide steps 0.6 and 8.4). nestjs-pino writes it for the
// routes of Nest; Better Auth answers /api/auth before the middleware of Nest runs, so bootstrap.ts
// gives those routes a request logger with the same options.

export const HTTP_LOGGING = Symbol('HTTP_LOGGING');

export const httpLoggingOf = (logger: Logger): Options => ({
  logger,
  // The request-id middleware sets req.id before pino-http runs.
  genReqId: (req) => (req as { id?: string }).id ?? uuidv7(),
  autoLogging: {
    ignore: (req) => (req.url ?? '').startsWith('/api/health'),
  },
  // pino-http brings its own serializer for errors, which keeps every field of an error.
  serializers: { ...logSerializers, ...httpLogSerializers },
});
