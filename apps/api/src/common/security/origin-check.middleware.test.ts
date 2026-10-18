import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOriginCheckMiddleware } from './origin-check.middleware';

const check = createOriginCheckMiddleware('http://localhost:3000/');

function run(method: string, headers: Record<string, string>) {
  const req = {
    method,
    id: 'req-1',
    originalUrl: '/api/organizations',
    headers,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn();
  const res = { status, type: () => res, json } as unknown as Response;
  status.mockReturnValue(res);
  const next = vi.fn();
  check(req, res, next);
  return { next, status, json };
}

describe('origin check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets safe methods through', () => {
    expect(run('GET', { origin: 'https://evil.example' }).next).toHaveBeenCalled();
  });

  it('accepts writes from the app origin and from clients without browser headers', () => {
    expect(
      run('POST', { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }).next,
    ).toHaveBeenCalled();
    expect(run('DELETE', {}).next).toHaveBeenCalled();
  });

  it('rejects writes from another origin or another site', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const foreign = run('POST', { origin: 'https://evil.example', 'x-real-ip': '203.0.113.9' });
    expect(foreign.next).not.toHaveBeenCalled();
    expect(foreign.status).toHaveBeenCalledWith(403);
    expect(foreign.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ORIGIN_REJECTED' }));

    expect(run('PATCH', { 'sec-fetch-site': 'cross-site' }).next).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      [
        {
          method: 'POST',
          route: '/api/organizations',
          clientAddress: '203.0.113.9',
          origin: 'https://evil.example',
          fetchSite: null,
        },
        'security.origin_rejected',
      ],
      [
        expect.objectContaining({ method: 'PATCH', origin: null, fetchSite: 'cross-site' }),
        'security.origin_rejected',
      ],
    ]);
  });
});
