import { generationEventSchema } from '@smp/contracts';
import type { GenerationEvent } from '@smp/core';
import type { Response } from 'express';

// Server-sent events over POST (guide step 2.7). Nest's @Sse() supports GET with observables
// only, so the controller writes the stream itself.
//
// - The first event comes after loading and the quota reservation. Until then nothing is sent,
//   so their errors still become problem documents with the right status (404, 402, 422).
// - A closed connection aborts the AI call: "close" on the response, not on the request, which
//   fires as soon as the body is read (Node 16 and later).
// - A comment line every 15 s keeps proxies from closing a quiet stream.
// - Every event passes the contract schema, so no internal field leaves the server.
// - There is no compression middleware in the API; one added later must skip text/event-stream.

export const HEARTBEAT_MS = 15_000;

export async function streamEvents(
  res: Response,
  events: AsyncGenerator<GenerationEvent>,
  abort: AbortController,
  heartbeatMs = HEARTBEAT_MS,
): Promise<void> {
  let step = await events.next();

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.on('close', () => {
    if (!res.writableEnded) {
      abort.abort();
    }
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);

  try {
    while (!step.done) {
      if (res.destroyed) {
        break;
      }
      const event = generationEventSchema.parse(step.value);
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      step = await events.next();
    }
  } finally {
    clearInterval(heartbeat);
    // Ends the use case if the client went away: its finally books the call.
    await events.return(undefined);
    if (!res.writableEnded) {
      res.end();
    }
  }
}
