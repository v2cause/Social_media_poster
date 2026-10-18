import type { Request, Response } from 'express';
import { currentLogContext, type LogContext } from '@smp/observability';
import { describe, expect, it, vi } from 'vitest';

import { requestIdMiddleware } from './request-id.middleware';

function run(incomingId: string | undefined) {
  const headers: Record<string, string> = {};
  const request = {
    get: (name: string) => (name === 'x-request-id' ? incomingId : undefined),
  } as unknown as Request;
  const response = {
    setHeader: (name: string, value: string) => (headers[name] = value),
  } as unknown as Response;
  const next = vi.fn(() => {
    seenInside = currentLogContext();
  });
  let seenInside: LogContext = {};

  requestIdMiddleware(request, response, next);

  return { request, headers, next, seenInside: () => seenInside };
}

describe('requestIdMiddleware', () => {
  it('gives the request an ID of its own and keeps a well-formed incoming one apart', () => {
    const result = run('client-req-20261015');

    const id = (result.request as Request & { id: string }).id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.headers['x-request-id']).toBe(id);
    expect(result.seenInside()).toEqual({ requestId: id, clientRequestId: 'client-req-20261015' });
  });

  it('drops an incoming ID that has an unsafe shape', () => {
    const result = run('bad id with spaces');

    expect(result.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.seenInside()).not.toHaveProperty('clientRequestId');
  });

  it('generates an ID when none is sent', () => {
    const result = run(undefined);

    expect(result.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.next).toHaveBeenCalledTimes(1);
  });
});
