import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { privatePath } from '@smp/observability';

import { clientAddress } from '../client-address';

// The security events of the API (guide step 8.4, ADR 0039, ASVS 16.3): requests the pipeline
// refuses and that may be an attack, each a warning with a message of its own. The log context
// adds the request ID and, once known, the user and the tenant. An event names what identifies
// the attempt (method, route, code, client address) and never carries request data: no body, no
// token, no value that failed validation. The events of the sign-in flows are auth.event
// (auth-hooks.ts).

export const SECURITY_EVENTS = [
  /** A state-changing request from another origin (CSRF). */
  'security.origin_rejected',
  /** A body that is no valid JSON, too large or in an unsupported encoding. */
  'security.body_rejected',
  /** A body or query that does not match the schema of the route. */
  'security.validation_failed',
  /** A workspace or organization the user is no member of. */
  'security.tenant_denied',
  /** A route the role of the user does not permit. */
  'security.permission_denied',
  /** A member without a second factor in an organization that requires one. */
  'security.two_factor_required',
  /** A request beyond a rate limit or a limit of open streams. */
  'security.rate_limited',
  /** A webhook without a valid signature. */
  'security.webhook_rejected',
  /** An OAuth callback with an unknown, used or foreign state. */
  'security.oauth_rejected',
  /** A callback, redirect or origin of an auth request that is not of the app (open redirect). */
  'security.redirect_rejected',
  /** A wrong password where an action asks for it again, such as switching the X browser on. */
  'security.password_rejected',
] as const;
export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

const logger = new Logger('SecurityEvents');

/** The longest value of the request an event keeps, such as an Origin or a slug. */
const MAX_VALUE_LENGTH = 200;

/** A value of the request as an event keeps it: shortened, or null when the request had none. */
export const clipped = (value: unknown): string | null =>
  typeof value === 'string' ? value.slice(0, MAX_VALUE_LENGTH) : null;

/** The route of a request: its pattern once Express matched it, otherwise the path. */
export function routeOf(req: Pick<Request, 'originalUrl' | 'url'> & { route?: unknown }): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  return typeof pattern === 'string' ? pattern : (privatePath(req.originalUrl || req.url) ?? '');
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

/**
 * Logs the requests to /api/auth that a rate limit refused: those of Better Auth per address and
 * path, which no hook sees, and those of the hooks per account, which auth.event names as well.
 */
export function authRateLimitEvents(req: Request, res: Response, next: NextFunction): void {
  // The path of the endpoint; once the handler of Better Auth matched, the route is its wildcard.
  const route = routeOf(req);
  res.on('finish', () => {
    if (res.statusCode === 429) {
      logSecurityEvent('security.rate_limited', req, { route, limiter: 'auth' });
    }
  });
  next();
}
