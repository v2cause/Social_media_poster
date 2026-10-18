import { Logger } from '@nestjs/common';
import type { Request } from 'express';

import { clientAddress } from '../throttling/throttling';
import { pathOnly } from './http-log-serializers';

// The security events of the API (guide step 8.4, ADR 0039, ASVS 16.3): requests the pipeline
// refuses and that may be an attack, each a warning with a message of its own. The log context
// adds the request ID and, once known, the user and the tenant. An event names what identifies
// the attempt (method, route, code, client address) and never carries request data: no body, no
// token, no value that failed validation. The events of the sign-in flows are auth.event
// (auth-hooks.ts).

export const SECURITY_EVENTS = [
  /** A body that is no valid JSON, too large or in an unsupported encoding. */
  'security.body_rejected',
] as const;
export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

const logger = new Logger('SecurityEvents');

/** The route of a request: its pattern once Express matched it, otherwise the path. */
export function routeOf(req: Pick<Request, 'originalUrl' | 'url'> & { route?: unknown }): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  return typeof pattern === 'string' ? pattern : (pathOnly(req.originalUrl || req.url) ?? '');
}

/** Logs the event with the method, the route and the client address of the request. */
export function logSecurityEvent(
  event: SecurityEvent,
  req: Pick<Request, 'method' | 'originalUrl' | 'url' | 'headers' | 'ip'> & { route?: unknown },
  fields: Record<string, unknown> = {},
): void {
  logger.warn(
    { method: req.method, route: routeOf(req), clientAddress: clientAddress(req), ...fields },
    event,
  );
}
