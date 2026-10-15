import type { Request, Response } from 'express';
import { currentLogContext } from '@smp/observability';
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
    seenInside = currentLogContext().requestId;
  });
  let seenInside: string | undefined;

  requestIdMiddleware(request, response, next);

  return { request, headers, next, seenInside: () => seenInside };
}

describe('requestIdMiddleware', () => {
  it('keeps a well-formed incoming request ID', () => {
    const result = run('client-req-20261015');

    expect((result.request as Request & { id: string }).id).toBe('client-req-20261015');
    expect(result.headers['x-request-id']).toBe('client-req-20261015');
    expect(result.seenInside()).toBe('client-req-20261015');
  });

  it('replaces an incoming ID that has an unsafe shape', () => {
    const result = run('bad id with spaces');

    expect((result.request as Request & { id: string }).id).not.toBe('bad id with spaces');
    expect(result.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates an ID when none is sent', () => {
    const result = run(undefined);

    expect(result.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.next).toHaveBeenCalledTimes(1);
  });
});
