import type { NextFunction, Request, Response } from 'express';

// Request bodies and caching of the API (guide step 8.4, ADR 0039).
//
// Better Auth reads the whole body of a request before it looks at it, without a limit of its own.
// Its requests are small JSON documents, so a body above AUTH_BODY_LIMIT_BYTES, or one sent in
// chunks without a length, is refused before it reaches Better Auth. The body parsers of the other
// routes have their own limits (bootstrap.ts).

export const AUTH_BODY_LIMIT_BYTES = 64 * 1024;

function refuse(req: Request, res: Response, status: 411 | 413, title: string, detail: string): void {
  res
    .status(status)
    .type('application/problem+json')
    .json({
      type: 'about:blank',
      title,
      status,
      code: `HTTP_${String(status)}`,
      detail,
      traceId: typeof req.id === 'string' ? req.id : 'unknown',
    });
}

export function authBodyLimit(req: Request, res: Response, next: NextFunction): void {
  const length = req.get('content-length');
  if (length === undefined) {
    if (req.get('transfer-encoding') !== undefined) {
      refuse(req, res, 411, 'Length Required', 'Requests to /api/auth need a Content-Length.');
      return;
    }
    next();
    return;
  }
  if (!/^\d+$/.test(length) || Number(length) > AUTH_BODY_LIMIT_BYTES) {
    refuse(
      req,
      res,
      413,
      'Content Too Large',
      `Requests to /api/auth carry at most ${String(AUTH_BODY_LIMIT_BYTES)} bytes.`,
    );
    return;
  }
  next();
}

/**
 * Answers of the API are for the one who asked: no browser or proxy keeps them (ASVS 14.3.2). A
 * route that allows caching sets its own header after this one.
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
