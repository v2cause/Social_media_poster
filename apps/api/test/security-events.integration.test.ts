import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { browser } from './support/browser';

// Guide step 8.4 (ADR 0039, ASVS 16.3): the requests the pipeline refuses answer with the status
// that fits and leave a security event in the log, a warning with the route and the client
// address, never with what the request carried.

describe('security events of the API', () => {
  let api: ApiTestApp | undefined;

  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };
  /** The security events logged since the spy started, as [fields, message]. */
  const events = (warn: { mock: { calls: unknown[][] } }): [Record<string, unknown>, string][] =>
    warn.mock.calls
      .filter((call) => typeof call[1] === 'string' && call[1].startsWith('security.'))
      .map((call) => [call[0] as Record<string, unknown>, call[1] as string]);

  beforeAll(async () => {
    api = await startApiTestApp();
  });

  afterAll(async () => {
    await api?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers a body above the limit with 413 and broken JSON with 400, without quoting it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const client = browser(started().server, '198.51.100.40');

    const tooLarge = await client
      .post('/api/organizations')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ name: 'x'.repeat(1_100_000) }));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toMatchObject({ code: 'HTTP_413', detail: 'The request body is too large.' });

    const broken = await client
      .post('/api/organizations')
      .set('Content-Type', 'application/json')
      .send('{"password": "hunter2-secret"');
    expect(broken.status).toBe(400);
    expect(broken.body).toMatchObject({ code: 'HTTP_400', detail: 'The request body is not valid JSON.' });
    expect(broken.text).not.toContain('hunter2');

    expect(events(warn)).toEqual([
      [
        expect.objectContaining({
          method: 'POST',
          route: '/api/organizations',
          clientAddress: '198.51.100.40',
          status: 413,
          reason: 'entity.too.large',
        }),
        'security.body_rejected',
      ],
      [expect.objectContaining({ status: 400, reason: 'entity.parse.failed' }), 'security.body_rejected'],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2');
  });
});
