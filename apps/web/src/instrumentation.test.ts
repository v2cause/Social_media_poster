import { afterEach, describe, expect, it, vi } from 'vitest';

import { onRequestError } from './instrumentation';

// A server error of the web app leaves one structured line with the request ID of the proxy and
// the digest Next.js shows, without the message, the query or the headers of the request.

type Context = Parameters<typeof onRequestError>[2];

const context: Context = {
  routerKind: 'App Router',
  routePath: '/w/[ws]/posts',
  routeType: 'render',
  renderSource: 'react-server-components',
  revalidateReason: undefined,
};

describe('onRequestError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs request.failed with request ID, route and digest, and nothing of the message', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const error = Object.assign(new TypeError('fetch failed for ada@example.test'), {
      digest: '2910418836',
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3001'), { code: 'ECONNREFUSED' }),
    });

    await onRequestError(
      error,
      {
        path: '/w/demo/posts?q=secret',
        method: 'GET',
        headers: { 'x-request-id': '7d0c0a3e-5b8e-4f43-9d2c-0f7a1e2b3c4d', cookie: 'smp.session_token=abc' },
      },
      context,
    );

    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: 50,
      service: 'web',
      msg: 'request.failed',
      requestId: '7d0c0a3e-5b8e-4f43-9d2c-0f7a1e2b3c4d',
      method: 'GET',
      path: '/w/demo/posts',
      route: '/w/[ws]/posts',
      routeType: 'render',
      err: { type: 'TypeError', digest: '2910418836', code: 'ECONNREFUSED' },
    });
    expect(line).not.toMatch(/ada@example|secret|session_token|127\.0\.0\.1/);
  });

  it('logs a request without ID and a thrown value that is no error', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await onRequestError(
      'boom',
      { path: '/', method: 'POST', headers: {} },
      { ...context, routeType: 'action' },
    );

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      requestId: null,
      routeType: 'action',
      err: { type: 'string', digest: null, code: null },
    });
  });
});
