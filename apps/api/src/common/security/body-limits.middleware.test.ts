import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { AUTH_BODY_LIMIT_BYTES, authBodyLimit, noStore } from './body-limits.middleware';

function run(headers: Record<string, string>) {
  const req = { id: 'req-1', get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn();
  const res = { status, type: () => res, json } as unknown as Response;
  status.mockReturnValue(res);
  const next = vi.fn();
  authBodyLimit(req, res, next);
  return { next, status, json };
}

describe('the body limit of /api/auth', () => {
  it('lets small bodies and requests without a body through', () => {
    expect(run({ 'content-length': '120' }).next).toHaveBeenCalled();
    expect(run({ 'content-length': String(AUTH_BODY_LIMIT_BYTES) }).next).toHaveBeenCalled();
    expect(run({}).next).toHaveBeenCalled();
  });

  it('refuses a larger body and an odd length with 413', () => {
    for (const length of [String(AUTH_BODY_LIMIT_BYTES + 1), '1e9', '-1']) {
      const result = run({ 'content-length': length });
      expect(result.next).not.toHaveBeenCalled();
      expect(result.status).toHaveBeenCalledWith(413);
      expect(result.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'HTTP_413' }));
    }
  });

  it('refuses a body in chunks without a length with 411', () => {
    const result = run({ 'transfer-encoding': 'chunked' });
    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(411);
  });
});

describe('noStore', () => {
  it('marks the answer as not to be stored', () => {
    const setHeader = vi.fn();
    const next = vi.fn();
    noStore({} as Request, { setHeader } as unknown as Response, next);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).toHaveBeenCalled();
  });
});
