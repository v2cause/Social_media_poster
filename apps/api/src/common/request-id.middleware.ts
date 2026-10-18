import type { NextFunction, Request, Response } from 'express';
import { runWithLogContext } from '@smp/observability';
import { uuidv7 } from 'uuidv7';

// A caller's request ID of a safe shape goes to the logs as clientRequestId; anything else is
// dropped.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Gives every request an ID of its own, in req.id, the x-request-id response header and the log
 * context, so every log line written during the request carries it. The ID a caller sends is never
 * taken as ours: a client could reuse the ID of another request and mix up their logs.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const requestId = uuidv7();

  (req as Request & { id: string }).id = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  const clientRequestId = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : undefined;
  runWithLogContext({ requestId, ...(clientRequestId ? { clientRequestId } : {}) }, () => {
    next();
  });
}
