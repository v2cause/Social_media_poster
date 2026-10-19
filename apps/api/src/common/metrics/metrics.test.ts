import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';

import type { NextFunction, Request, Response } from 'express';
import { Counter, Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';

import { apiMetrics, httpMetrics, startMetricsServer } from './metrics';

// Guide step 8.7: the duration of the requests by method and status class, without the health
// checks and the streams of server-sent events, served on a port of its own.

function request(method: string, url: string, status: number, contentType?: string): Promise<void> {
  const response = Object.assign(new EventEmitter(), {
    statusCode: status,
    getHeader: (name: string) => (name === 'content-type' ? contentType : undefined),
  });
  return new Promise((resolve) => {
    const next: NextFunction = () => {
      response.emit('finish');
      resolve();
    };
    httpMetrics({ method, originalUrl: url } as Request, response as unknown as Response, next);
  });
}

describe('the metrics of the API', () => {
  afterEach(() => {
    apiMetrics.resetMetrics();
  });

  it('observes requests by method and status class, not health checks or streams', async () => {
    await request('GET', '/api/w/demo/posts?status=FAILED', 200);
    await request('POST', '/api/organizations', 503);
    await request('PROPFIND', '/api/me', 405);
    await request('GET', '/api/health/ready', 200);
    await request('GET', '/api/w/demo/live', 200, 'text/event-stream');

    const text = await apiMetrics.getSingleMetricAsString('smp_http_request_duration_seconds');
    expect(text).toContain('smp_http_request_duration_seconds_count{method="GET",status_class="2xx"} 1');
    expect(text).toContain('smp_http_request_duration_seconds_count{method="POST",status_class="5xx"} 1');
    expect(text).toContain('smp_http_request_duration_seconds_count{method="OTHER",status_class="4xx"} 1');
    expect(text).not.toContain('demo');
  });

  it('serves GET /metrics and nothing else on its port', async () => {
    const registry = new Registry();
    new Counter({ name: 'smp_example_total', help: 'An example', registers: [registry] }).inc();
    const server = startMetricsServer(0, registry);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toContain('smp_example_total 1');
      expect((await fetch(`${base}/api/me`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
