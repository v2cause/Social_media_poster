import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createOriginCheckMiddleware } from './origin-check.middleware';

const check = createOriginCheckMiddleware('http://localhost:3000/');

function run(method: string, headers: Record<string, string>) {
  const req = {
    method,
    id: 'req-1',
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
    const foreign = run('POST', { origin: 'https://evil.example' });
    expect(foreign.next).not.toHaveBeenCalled();
    expect(foreign.status).toHaveBeenCalledWith(403);
    expect(foreign.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ORIGIN_REJECTED' }));

    expect(run('PATCH', { 'sec-fetch-site': 'cross-site' }).next).not.toHaveBeenCalled();
  });
});
