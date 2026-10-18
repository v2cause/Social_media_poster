import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { browser, PASSWORD, signUpVerified } from './support/browser';

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

  it('logs writes from another origin, foreign tenants, routes beyond the role and bad input', async () => {
    const owner = await signUpVerified(started(), 'owner@events.test');
    const created = await owner
      .post('/api/organizations')
      .send({
        name: 'Events GmbH',
        workspace: {
          name: 'Events',
          timezone: 'Europe/Berlin',
          contentLanguage: 'de',
          industry: '',
          targetAudience: '',
          goals: '',
          contentPillars: [],
        },
      })
      .expect(201);
    const slug = (created.body as { workspaceSlug: string }).workspaceSlug;
    const outsider = await signUpVerified(started(), 'outsider@events.test');
    const warn = vi.spyOn(Logger.prototype, 'warn');

    const forged = await owner.post('/api/organizations').set('Origin', 'https://evil.example').send({});
    expect(forged.status).toBe(403);
    expect(forged.body).toMatchObject({ code: 'ORIGIN_REJECTED' });
    await outsider.get(`/api/w/${slug}`).expect(404);
    await outsider.get('/api/admin/x-browser').expect(403);
    const invalid = await owner.post('/api/organizations').send({ name: '', password: 'hunter2-secret' });
    expect(invalid.status).toBe(400);
    const nameTooShort: unknown = expect.arrayContaining([{ path: 'name', code: 'too_small' }]);

    expect(events(warn)).toEqual([
      [
        expect.objectContaining({ method: 'POST', origin: 'https://evil.example', fetchSite: null }),
        'security.origin_rejected',
      ],
      [
        expect.objectContaining({
          route: '/api/w/:ws',
          status: 404,
          code: 'WORKSPACE_NOT_FOUND',
          tenant: slug,
        }),
        'security.tenant_denied',
      ],
      [
        expect.objectContaining({ route: '/api/admin/x-browser', status: 403, code: 'NOT_PERMITTED' }),
        'security.permission_denied',
      ],
      [
        expect.objectContaining({
          route: '/api/organizations',
          code: 'VALIDATION_FAILED',
          issues: nameTooShort,
        }),
        'security.validation_failed',
      ],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2');
  });

  it('logs an OAuth callback with a forged state and sign-ins beyond the limit of Better Auth', async () => {
    const agent = await signUpVerified(started(), 'oauth@events.test');
    const warn = vi.spyOn(Logger.prototype, 'warn');

    const callback = await agent.get('/api/oauth/linkedin/callback?state=forged-state&code=stolen-code');
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('connect_error=STATE_INVALID');

    // Better Auth allows three requests per address, path and ten seconds.
    const client = browser(started().server, '198.51.100.41');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await client
        .post('/api/auth/sign-in/email')
        .send({ email: 'oauth@events.test', password: `${PASSWORD} wrong` });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);

    expect(events(warn)).toEqual([
      [
        expect.objectContaining({
          route: '/api/oauth/:platform/callback',
          platform: 'linkedin',
          reason: 'STATE_INVALID',
        }),
        'security.oauth_rejected',
      ],
      [
        expect.objectContaining({
          route: '/api/auth/sign-in/email',
          clientAddress: '198.51.100.41',
          limiter: 'auth',
        }),
        'security.rate_limited',
      ],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/forged-state|stolen-code/);
  });
});
