import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { makeNodeTransport } from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import { startConnectRecorder } from '@smp/testing';
import { describe, expect, it } from 'vitest';

import { buildSentryOptions, proxiedHttpModule, scrubEvent, scrubRequestHeaders } from './sentry';

describe('scrubRequestHeaders', () => {
  it('removes credential headers regardless of their case', () => {
    const headers = {
      Authorization: 'Bearer abc',
      Cookie: 'session=xyz',
      'set-cookie': 'session=new',
      'user-agent': 'vitest',
    };

    expect(scrubRequestHeaders(headers)).toEqual({ 'user-agent': 'vitest' });
  });
});

describe('scrubEvent', () => {
  it('removes cookies, the request body and the query string', () => {
    const event = {
      type: undefined,
      request: {
        url: 'https://app.example.com/api/oauth/x/callback',
        method: 'POST',
        headers: { Cookie: 'session=xyz', 'user-agent': 'vitest' },
        cookies: { session: 'xyz' },
        data: { password: 'hunter2' },
        query_string: 'code=secret&state=abc',
      },
    } as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(scrubbed.request).toEqual({
      url: 'https://app.example.com/api/oauth/x/callback',
      method: 'POST',
      headers: { 'user-agent': 'vitest' },
    });
  });

  it('leaves events without a request unchanged', () => {
    const event = { type: undefined, message: 'boom' } as ErrorEvent;

    expect(scrubEvent(event)).toEqual({ type: undefined, message: 'boom' });
  });
});

describe('buildSentryOptions', () => {
  it('turns off every collection of personal data, customer content and credentials', () => {
    const options = buildSentryOptions('https://key@sentry.example.com/1', 'production');

    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
    });
    expect(options.dataCollection?.httpHeaders).toEqual({
      request: { allow: ['content-type', 'user-agent', 'x-request-id'] },
      response: { allow: ['content-type'] },
    });
    expect(options.beforeSend).toBeTypeOf('function');
  });
});

describe('the transport behind the egress proxy (guide step 8.9)', () => {
  /** Sends one event with the transport of Sentry to the URL and waits for the answer or the error. */
  const sendEvent = async (url: string, httpModule: ReturnType<typeof proxiedHttpModule>): Promise<void> => {
    const transport = makeNodeTransport({ url, httpModule, recordDroppedEvent: () => undefined });
    const envelope = [{}, [[{ type: 'event' }, { event_id: '0'.repeat(32) }]]];
    // The recorder refuses every tunnel; the tests look at what reached it, not at the answer.
    await Promise.resolve(transport.send(envelope as unknown as Parameters<typeof transport.send>[0])).catch(
      () => undefined,
    );
  };

  it('is the http module of the transport only when the process has a proxy', () => {
    const dsn = 'https://key@sentry.example.com/1';

    expect(buildSentryOptions(dsn, 'production').transportOptions).toBeUndefined();
    expect(
      buildSentryOptions(dsn, 'production', { HTTPS_PROXY: 'http://egress:3128' }).transportOptions
        ?.httpModule,
    ).toBeDefined();
  });

  it('opens a tunnel through the proxy to a Sentry outside the network', async () => {
    const proxy = await startConnectRecorder();

    await sendEvent(
      'https://sentry.example.test/api/1/envelope/',
      proxiedHttpModule({ HTTPS_PROXY: proxy.url }),
    );
    await proxy.stop();

    expect(proxy.tunnels).toEqual(['sentry.example.test:443']);
  });

  it('reaches a Sentry that NO_PROXY names directly', async () => {
    const proxy = await startConnectRecorder();
    let received = 0;
    const sentry = createServer((request, response) => {
      received += 1;
      request.resume();
      response.writeHead(200).end();
    });
    await new Promise<void>((resolve) => sentry.listen(0, '127.0.0.1', resolve));
    const { port } = sentry.address() as AddressInfo;

    await sendEvent(
      `http://127.0.0.1:${String(port)}/api/1/envelope/`,
      proxiedHttpModule({ HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1' }),
    );
    sentry.closeAllConnections();
    await new Promise((resolve) => sentry.close(resolve));
    await proxy.stop();

    expect(received).toBe(1);
    expect(proxy.tunnels).toEqual([]);
  });
});
