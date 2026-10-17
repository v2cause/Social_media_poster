import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { liveEventDtoSchema, type LiveEventDto } from '@smp/contracts';
import type { LiveEvent } from '@smp/queue';
import type { Response } from 'express';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, MissingAccessError, type RequestAccess } from '../../common/guards/request-access';
import { HEARTBEAT_MS } from '../content/sse';
import { LiveEventHub } from './live-event-hub';

const EVENT_STREAM = {
  description:
    'Server-sent events: variant.status, notification.created and xb.login (schema liveEventDtoSchema in @smp/contracts).',
  content: { 'text/event-stream': { schema: { type: 'string' } } },
} as const;

/** The browser waits this long before it opens a lost stream again. */
const RETRY_MS = 5_000;

/** What the user of a stream may see of an event: a notification goes to its user only. */
export function toLiveEventDto(event: LiveEvent, userId: string): LiveEventDto | null {
  if (event.type === 'notification.created') {
    return event.userId === userId ? { type: 'notification.created', id: event.id } : null;
  }
  if (event.type === 'xb.login') {
    const parsed = liveEventDtoSchema.safeParse({
      type: 'xb.login',
      loginSessionId: event.loginSessionId,
      status: event.status,
    });
    return event.userId === userId && parsed.success ? parsed.data : null;
  }
  const parsed = liveEventDtoSchema.safeParse(event);
  return parsed.success ? parsed.data : null;
}

@ApiTags('live')
@WorkspaceScope()
@Controller('w/:ws/events')
export class LiveEventsController {
  constructor(private readonly hub: LiveEventHub) {}

  /**
   * The live events of the workspace as server-sent events (guide step 4.10). The access is
   * checked when the stream opens; the events carry ids only, the browser reads the rest.
   */
  @Get()
  @RequirePermission('workspace.read')
  @ApiOkResponse(EVENT_STREAM)
  async stream(@Access() access: RequestAccess, @Res() res: Response): Promise<void> {
    const { workspaceId, userId } = access;
    if (!workspaceId) {
      throw new MissingAccessError();
    }
    const unsubscribe = await this.hub.subscribe(workspaceId, (event) => {
      const dto = res.destroyed ? null : toLiveEventDto(event, userId);
      if (dto) {
        res.write(`event: ${dto.type}\ndata: ${JSON.stringify(dto)}\n\n`);
      }
    });
    if (res.destroyed) {
      // The browser left while the subscription started.
      await unsubscribe();
      return;
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`retry: ${String(RETRY_MS)}\n\n`);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    res.on('close', () => {
      clearInterval(heartbeat);
      void unsubscribe();
    });
  }
}
