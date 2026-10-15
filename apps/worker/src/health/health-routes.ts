import type { Registry } from 'prom-client';

export interface ReadinessCheck {
  name: string;
  run: () => Promise<void>;
}

export interface RouteResponse {
  status: number;
  contentType: string;
  body: string;
}

const CHECK_TIMEOUT_MS = 2_000;

const json = (status: number, payload: unknown): RouteResponse => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(payload),
});

async function runCheck(check: ReadinessCheck): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('readiness check timed out'));
    }, CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check.run(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answers the three routes of the worker's HTTP port. Liveness reports the process only.
 * Readiness runs the dependency checks, each with a timeout. Metrics come from the registry.
 */
export async function routeHealthRequest(
  url: string,
  checks: ReadinessCheck[],
  registry: Registry,
): Promise<RouteResponse> {
  switch (url) {
    case '/health/live':
      return json(200, { status: 'ok' });
    case '/health/ready': {
      const results = await Promise.all(
        checks.map(async (check) => [check.name, await runCheck(check)] as const),
      );
      const ready = results.every(([, state]) => state === 'up');
      return json(ready ? 200 : 503, {
        status: ready ? 'ok' : 'unavailable',
        checks: Object.fromEntries(results),
      });
    }
    case '/metrics':
      return { status: 200, contentType: registry.contentType, body: await registry.metrics() };
    default:
      return json(404, { status: 'not_found' });
  }
}
