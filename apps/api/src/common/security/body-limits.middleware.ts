import { STATUS_CODES } from 'node:http';

import type { NextFunction, Request, Response } from 'express';

import { logSecurityEvent } from '../logging/security-events';

// Request bodies and caching of the API (guide step 8.4, ADR 0039).
//
// Better Auth reads the whole body of a request before it looks at it, without a limit of its own.
// Its requests are small JSON documents, so a body above AUTH_BODY_LIMIT_BYTES, or one sent in
// chunks without a length, is refused before it reaches Better Auth. The body parsers of the other
// routes have their own limits (bootstrap.ts); a body they refuse gets its status from bodyErrors.

export const AUTH_BODY_LIMIT_BYTES = 64 * 1024;

function refuse(req: Request, res: Response, status: number, title: string, detail: string): void {
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

/** An error of the body parsers of Express (body-parser), with the status it stands for. */
interface BodyParserError {
  status: number;
  type: string;
}

const isBodyParserError = (error: unknown): error is Error & BodyParserError =>
  error instanceof Error &&
  typeof (error as Partial<BodyParserError>).status === 'number' &&
  typeof (error as Partial<BodyParserError>).type === 'string';

const BODY_DETAILS: Partial<Record<number, string>> = {
  400: 'The request body is not valid JSON.',
  413: 'The request body is too large.',
  415: 'The encoding of the request body is not supported.',
};

/**
 * Answers a body the parsers refused with its status, such as 413 for one above the limit, where
 * it was a server error before, and logs it as a security event. The message of the parser,
 * which may quote the body, reaches neither the answer nor the log.
 */
export function bodyErrors(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (!isBodyParserError(error) || error.status < 400 || error.status >= 500) {
    next(error);
    return;
  }
  if (error.type === 'request.aborted' || res.headersSent) {
    // The client went away while it sent the body; nobody reads an answer.
    return;
  }
  logSecurityEvent('security.body_rejected', req, { status: error.status, reason: error.type });
  refuse(
    req,
    res,
    error.status,
    STATUS_CODES[error.status] ?? 'Bad Request',
    BODY_DETAILS[error.status] ?? 'The request body was refused.',
  );
}

/**
 * Answers of the API are for the one who asked: no browser or proxy keeps them (ASVS 14.3.2). A
 * route that allows caching sets its own header after this one.
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
