import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PlatformError } from '@smp/core';

import { PlatformRateLimiter } from '../rate-limit/platform-rate-limiter';
import { PlatformHttpClient } from './platform-http-client';

// Guide step 4.4: one HTTP client for all adapters, without retries of its own, with checked
// answers, the error taxonomy and logs without tokens.

const API = 'https://api.platform.example';
const server = setupServer();
const postSchema = z.object({ id: z.string() });

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const logs: Record<string, unknown>[] = [];
const client = (limiter?: PlatformRateLimiter) =>
  new PlatformHttpClient({
    platform: 'LINKEDIN',
    logger: { info: (fields) => logs.push(fields), warn: () => undefined },
    ...(limiter ? { limiter } : {}),
  });

const codeOf = async (promise: Promise<unknown>) => {
  const error = (await promise.then(
    () => null,
    (failed: unknown) => failed,
  )) as { code?: string; retryAfterMs?: number };
  return { code: error.code, retryAfterMs: error.retryAfterMs };
};

describe('PlatformHttpClient', () => {
  it('returns the checked answer and logs neither query nor body', async () => {
    let received: { body: unknown; type: string | null } | undefined;
    server.use(
      http.post(`${API}/rest/posts`, async ({ request }) => {
        received = { body: await request.json(), type: request.headers.get('content-type') };
        return HttpResponse.json({ id: 'urn:li:share:1', extra: true }, { status: 201 });
      }),
    );

    const response = await client().request({
      operation: 'linkedin.posts.create',
      method: 'POST',
      url: `${API}/rest/posts?access_token=secret-token`,
      body: { json: { commentary: 'Hallo' } },
      schema: postSchema,
    });

    expect(response.data).toEqual({ id: 'urn:li:share:1' });
    expect(received).toEqual({ body: { commentary: 'Hallo' }, type: 'application/json' });
    const log = logs.at(-1);
    expect(log).toMatchObject({
      operation: 'linkedin.posts.create',
      method: 'POST',
      path: '/rest/posts',
      status: 201,
    });
    expect(JSON.stringify(logs)).not.toContain('secret-token');
  });

  it.each([
    [401, 'AUTH_EXPIRED'],
    [403, 'PERMISSION_DENIED'],
    [422, 'VALIDATION_REJECTED'],
    [500, 'TRANSIENT'],
  ])('maps HTTP %i to %s', async (status, code) => {
    server.use(http.get(`${API}/me`, () => HttpResponse.json({ message: 'no' }, { status })));
    await expect(
      codeOf(client().request({ operation: 'me', method: 'GET', url: `${API}/me` })),
    ).resolves.toMatchObject({ code });
  });

  it('lets an adapter map its own errors first', async () => {
    server.use(
      http.post(`${API}/2/tweets`, () => HttpResponse.json({ detail: 'duplicate content' }, { status: 403 })),
    );
    const result = await codeOf(
      client().request({
        operation: 'x.tweets.create',
        method: 'POST',
        url: `${API}/2/tweets`,
        mapError: ({ body, status }) =>
          JSON.stringify(body).includes('duplicate')
            ? new PlatformError('DUPLICATE', 'duplicate content', { status })
            : undefined,
      }),
    );
    expect(result.code).toBe('DUPLICATE');
  });

  it('feeds the limiter with the wait of a 429 and refuses further calls until it is over', async () => {
    const limiter = PlatformRateLimiter.memory();
    server.use(
      http.get(
        `${API}/feed`,
        () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '30' } }),
      ),
    );
    const call = () =>
      client(limiter).request({
        operation: 'feed',
        method: 'GET',
        url: `${API}/feed`,
        rateLimit: { accountId: 'acc-1' },
      });

    await expect(codeOf(call())).resolves.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 30_000 });
    const blocked = await codeOf(call());
    expect(blocked.code).toBe('RATE_LIMITED');
    expect(blocked.retryAfterMs).toBeGreaterThan(25_000);
  });

  it('separates unsent calls from lost answers of create calls', async () => {
    const refused = new PlatformHttpClient({
      platform: 'X',
      fetch: () =>
        Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
    });
    await expect(
      codeOf(refused.request({ operation: 'down', method: 'POST', url: `${API}/posts` })),
    ).resolves.toMatchObject({ code: 'TRANSIENT' });
    server.use(http.post(`${API}/reset`, () => HttpResponse.error()));
    await expect(
      codeOf(client().request({ operation: 'reset', method: 'POST', url: `${API}/reset` })),
    ).resolves.toMatchObject({ code: 'OUTCOME_UNKNOWN' });

    server.use(
      http.post(`${API}/slow`, async () => {
        await delay(500);
        return HttpResponse.json({ id: '1' });
      }),
      http.get(`${API}/slow`, async () => {
        await delay(500);
        return HttpResponse.json({ id: '1' });
      }),
    );
    await expect(
      codeOf(
        client().request({
          operation: 'slow',
          method: 'POST',
          url: `${API}/slow`,
          timeoutMs: 50,
          schema: postSchema,
        }),
      ),
    ).resolves.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await expect(
      codeOf(
        client().request({
          operation: 'slow',
          method: 'GET',
          url: `${API}/slow`,
          timeoutMs: 50,
          schema: postSchema,
        }),
      ),
    ).resolves.toMatchObject({ code: 'TRANSIENT' });
  });

  it('names the code of a failed connection, and counts a failed TLS handshake as not sent', async () => {
    const create = (code: string) =>
      new PlatformHttpClient({
        platform: 'X',
        fetch: () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code } })),
      }).request({ operation: 'post.create', method: 'POST', url: `${API}/posts` });
    await expect(create('CERT_HAS_EXPIRED')).rejects.toMatchObject({
      code: 'TRANSIENT',
      message: 'post.create could not connect (CERT_HAS_EXPIRED)',
    });
    await expect(create('ECONNRESET')).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      message: 'post.create sent, but the answer is missing (TypeError, ECONNRESET)',
    });
    await expect(create('not a code\n')).rejects.toMatchObject({
      message: 'post.create sent, but the answer is missing (TypeError)',
    });
  });

  it('refuses an answer that does not match its schema', async () => {
    server.use(http.post(`${API}/rest/posts`, () => HttpResponse.json({ unexpected: true })));
    await expect(
      codeOf(
        client().request({
          operation: 'create',
          method: 'POST',
          url: `${API}/rest/posts`,
          schema: postSchema,
        }),
      ),
    ).resolves.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });
});
