import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTH_BODY_LIMIT_BYTES, authBodyLimit, bodyErrors, noStore } from './body-limits.middleware';

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

describe('bodyErrors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An error as body-parser makes it: the error of JSON.parse with status and type. */
  const parserError = (status: number, type: string): Error =>
    Object.assign(new SyntaxError('Unexpected token \'s\', "secret-password" is not valid JSON'), {
      status,
      type,
    });

  function fail(error: unknown) {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const req = {
      id: 'req-1',
      method: 'POST',
      originalUrl: '/api/organizations?invite=token',
      url: '/api/organizations?invite=token',
      headers: { 'x-real-ip': '198.51.100.7' },
    } as unknown as Request;
    const json = vi.fn();
    const status = vi.fn();
    const res = { status, type: () => res, json, headersSent: false } as unknown as Response;
    status.mockReturnValue(res);
    const next = vi.fn();
    bodyErrors(error, req, res, next);
    return { next, status, json, warn };
  }

  it('answers a body the parsers refused with its status and logs it without the body', () => {
    const tooLarge = fail(parserError(413, 'entity.too.large'));
    expect(tooLarge.status).toHaveBeenCalledWith(413);
    expect(tooLarge.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'HTTP_413',
        detail: 'The request body is too large.',
        traceId: 'req-1',
      }),
    );
    expect(tooLarge.warn).toHaveBeenCalledWith(
      {
        method: 'POST',
        route: '/api/organizations',
        clientAddress: '198.51.100.7',
        status: 413,
        reason: 'entity.too.large',
      },
      'security.body_rejected',
    );

    const broken = fail(parserError(400, 'entity.parse.failed'));
    expect(broken.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'HTTP_400', detail: 'The request body is not valid JSON.' }),
    );
    expect(JSON.stringify([broken.json.mock.calls, broken.warn.mock.calls])).not.toContain('secret');
    expect(broken.next).not.toHaveBeenCalled();
  });

  it('passes other errors on and answers nobody who went away', () => {
    const failure = new Error('database down');
    expect(fail(failure).next).toHaveBeenCalledWith(failure);
    const internal = parserError(500, 'stream.encoding.set');
    expect(fail(internal).next).toHaveBeenCalledWith(internal);

    const aborted = fail(parserError(400, 'request.aborted'));
    expect(aborted.status).not.toHaveBeenCalled();
    expect(aborted.next).not.toHaveBeenCalled();
    expect(aborted.warn).not.toHaveBeenCalled();
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
