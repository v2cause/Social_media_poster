import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { type ReadinessCheck, routeHealthRequest } from './health-routes';

const up: ReadinessCheck = { name: 'redis', run: () => Promise.resolve() };
const down: ReadinessCheck = { name: 'database', run: () => Promise.reject(new Error('password=hunter2')) };

describe('routeHealthRequest', () => {
  it('reports liveness without running any check', async () => {
    const response = await routeHealthRequest('/health/live', [down], new Registry());

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });

  it('reports readiness when every dependency is up', async () => {
    const response = await routeHealthRequest('/health/ready', [up], new Registry());

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', checks: { redis: 'up' } });
  });

  it('reports 503 and the failing check, without the error text', async () => {
    const response = await routeHealthRequest('/health/ready', [up, down], new Registry());

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      status: 'unavailable',
      checks: { redis: 'up', database: 'down' },
    });
    expect(response.body).not.toContain('hunter2');
  });

  it('serves the metrics in the registry format', async () => {
    const registry = new Registry();
    registry.registerMetric(
      new (await import('prom-client')).Counter({
        name: 'smp_test_total',
        help: 'test',
        registers: [registry],
      }),
    );

    const response = await routeHealthRequest('/metrics', [], registry);

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/plain');
    expect(response.body).toContain('smp_test_total');
  });

  it('answers unknown paths with 404', async () => {
    const response = await routeHealthRequest('/nope', [], new Registry());

    expect(response.status).toBe(404);
  });
});
