import { describe, expect, it } from 'vitest';

import type { ErrorEvent } from '@sentry/node';

import { buildSentryOptions, scrubEvent, scrubRequestHeaders } from './sentry';

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
