import type { Instrumentation } from 'next';

import { logServerEvent } from './lib/server/log';

// The errors Next.js catches while rendering, in route handlers, server actions and the proxy
// (guide step 8.7, ADR 0039, ASVS 16.3.4): one line request.failed with the request ID the proxy
// gave the request, method, path without its query, route, the digest Next.js shows instead of
// the message and the code of a failed connection, such as ECONNREFUSED when the API is down.
// Message and stack stay out of this line, as they can carry what a page rendered; the digest
// finds them in the output of Next.js.

const digestOf = (error: unknown): string | null => {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' ? digest : null;
};

/** The code Node gives the cause of a failed fetch, when it has the shape of one. */
const causeCodeOf = (error: unknown): string | null => {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(code) ? code : null;
};

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const requestId = request.headers['x-request-id'];
  logServerEvent('error', 'request.failed', {
    requestId: typeof requestId === 'string' ? requestId : null,
    method: request.method,
    path: request.path.split('?', 1)[0],
    route: context.routePath,
    routeType: context.routeType,
    err: {
      type: error instanceof Error ? error.name : typeof error,
      digest: digestOf(error),
      code: causeCodeOf(error),
    },
  });
};
