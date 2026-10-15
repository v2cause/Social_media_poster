import type { NextFunction, Request, Response } from 'express';
import { runWithLogContext } from '@smp/observability';
import { uuidv7 } from 'uuidv7';

// Accept a caller's request ID only if it has a safe shape. Anything else gets a new ID.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Sets req.id and the x-request-id response header, and puts the ID into the log context
 * so every log line written during the request carries it.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const requestId = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : uuidv7();

  (req as Request & { id: string }).id = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  runWithLogContext({ requestId }, () => {
    next();
  });
}
