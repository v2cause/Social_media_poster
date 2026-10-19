import { createServer, type Server } from 'node:http';

import type { NextFunction, Request, Response } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// The metrics of the API (architecture 12, guide step 8.7): the duration of the requests for the
// SLOs of availability and latency, security events, auth events and failed invalidations of the
// access cache. They go out on a port of their own (API_METRICS_PORT), which the reverse proxy
// does not reach. Labels name methods, status classes, events and paths of Better Auth, never a
// route of a tenant or a user.

export const apiMetrics = new Registry();

collectDefaultMetrics({ register: apiMetrics });

export const httpRequestDuration = new Histogram({
  name: 'smp_http_request_duration_seconds',
  help: 'Duration of the requests to the API, by method and class of the status',
  labelNames: ['method', 'status_class'] as const,
  buckets: [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5, 10],
  registers: [apiMetrics],
});

export const securityEventsTotal = new Counter({
  name: 'smp_security_events_total',
  help: 'Security events of the API, by event',
  labelNames: ['event'] as const,
  registers: [apiMetrics],
});

export const authEventsTotal = new Counter({
  name: 'smp_auth_events_total',
  help: 'Steps of signing up, in and out and of the second factor, by path and outcome',
  labelNames: ['path', 'outcome'] as const,
  registers: [apiMetrics],
});

/** A failed invalidation keeps an old access for up to 60 seconds (ADR 0039); it alerts. */
export const accessCacheInvalidationFailures = new Counter({
  name: 'smp_access_cache_invalidation_failures_total',
  help: 'Invalidations of the access cache in Redis that failed',
  registers: [apiMetrics],
});

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Observes every request but the health checks and the streams of server-sent events. */
export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  if (req.originalUrl.startsWith('/api/health')) {
    next();
    return;
  }
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    // A stream lasts as long as the browser keeps it open; its duration says nothing.
    if (String(res.getHeader('content-type') ?? '').startsWith('text/event-stream')) {
      return;
    }
    httpRequestDuration.observe(
      {
        method: METHODS.has(req.method) ? req.method : 'OTHER',
        status_class: `${String(Math.floor(res.statusCode / 100))}xx`,
      },
      Number(process.hrtime.bigint() - started) / 1e9,
    );
  });
  next();
}

/** Serves GET /metrics on the port; nothing else. */
export function startMetricsServer(port: number, registry: Registry = apiMetrics): Server {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    registry.metrics().then(
      (body) => {
        response.writeHead(200, { 'content-type': registry.contentType }).end(body);
      },
      () => {
        response.writeHead(500).end();
      },
    );
  });
  server.listen(port, '0.0.0.0');
  return server;
}
