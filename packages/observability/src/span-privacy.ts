import type { IncomingMessage, RequestOptions } from 'node:http';

import type { Attributes } from '@opentelemetry/api';

// What spans keep of a request (guide steps 0.6 and 8.4): no query, which may carry the token of
// a link or an OAuth code; no client address and no user agent, which are personal data; and for
// the one route with a token in its path, the reset link of Better Auth, only its prefix. The
// instrumentations take these attributes over their own; one set to undefined is dropped.

const TOKEN_PATHS = ['/api/auth/reset-password/'];
const REDACTED = 'REDACTED';

/** The path of a URL without query and fragment, with the token of a link masked. */
export function privatePath(url: string | undefined): string | undefined {
  const path = url?.split(/[?#]/, 1)[0];
  if (path === undefined) {
    return undefined;
  }
  const prefix = TOKEN_PATHS.find(
    (candidate) => path.startsWith(candidate) && path.length > candidate.length,
  );
  return prefix === undefined ? path : `${prefix}${REDACTED}`;
}

const WITHOUT_PERSONAL_DATA: Attributes = {
  'url.query': undefined,
  'client.address': undefined,
  'network.peer.address': undefined,
  'network.peer.port': undefined,
  'user_agent.original': undefined,
};

/** A server span: the requests to the API and to the health endpoints. */
export const incomingSpanAttributes = (request: Pick<IncomingMessage, 'url'>): Attributes => ({
  ...WITHOUT_PERSONAL_DATA,
  'url.path': privatePath(request.url),
});

/** A client span over node:http, for example the requests of the S3 and Stripe SDKs. */
export function outgoingSpanAttributes(
  options: Pick<RequestOptions, 'protocol' | 'hostname' | 'host' | 'port' | 'path'>,
): Attributes {
  const protocol = options.protocol ?? 'http:';
  const host = options.hostname ?? options.host ?? 'localhost';
  const port = options.port === undefined || options.port === null ? '' : `:${String(options.port)}`;
  return { 'url.full': `${protocol}//${host}${port}${privatePath(options.path ?? '/') ?? '/'}` };
}

/** A client span over fetch, for example the platform APIs and the AI provider. */
export const fetchSpanAttributes = (request: { origin: string; path: string }): Attributes => ({
  'url.full': `${request.origin}${privatePath(request.path) ?? '/'}`,
  'url.query': undefined,
});

/** The Redis command without its arguments, which hold job payloads with addresses and links. */
export const redisStatement = (command: string): string => command;
