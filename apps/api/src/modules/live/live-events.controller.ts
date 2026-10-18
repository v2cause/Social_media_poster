import { Controller, Get, HttpException, HttpStatus, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { liveEventDtoSchema, type LiveEventDto } from '@smp/contracts';
import type { LiveEvent } from '@smp/queue';
import type { Response } from 'express';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, MissingAccessError, type RequestAccess } from '../../common/guards/request-access';
import { HEARTBEAT_MS } from '../content/sse';
import { LiveEventHub } from './live-event-hub';
import { LiveStreamSlots } from './live-stream-slots';

const EVENT_STREAM = {
  description:
    'Server-sent events: variant.status, notification.created and xb.login (schema liveEventDtoSchema in @smp/contracts).',
  content: { 'text/event-stream': { schema: { type: 'string' } } },
} as const;

/** The browser waits this long before it opens a lost stream again. */
const RETRY_MS = 5_000;
/**
 * A stream ends after this long, and the browser opens it again through the guards (guide step
 * 8.4): after a sign-out, an ended session or a removal from the workspace, no events follow
 * beyond it. The browser reloads what it shows when the stream opens again.
 */
export const STREAM_LIFETIME_MS = 5 * 60_000;

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
  constructor(
    private readonly hub: LiveEventHub,
    private readonly slots: LiveStreamSlots,
  ) {}

  /**
   * The live events of the workspace as server-sent events (guide step 4.10). The access is
   * checked when the stream opens, and again whenever the browser opens it after its lifetime;
   * the events carry ids only, the browser reads the rest. A user keeps a limited number of
   * streams open, in all workspaces together (guide step 8.4).
   */
  @Get()
  @RequirePermission('workspace.read')
  @ApiOkResponse(EVENT_STREAM)
  async stream(@Access() access: RequestAccess, @Res() res: Response): Promise<void> {
    const { workspaceId, userId } = access;
    if (!workspaceId) {
      throw new MissingAccessError();
    }
    const slot = await this.slots.acquire(userId);
    if (!slot) {
      throw new HttpException(
        'Too many live streams are open; close another tab.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    let unsubscribe: () => Promise<void>;
    try {
      unsubscribe = await this.hub.subscribe(workspaceId, (event) => {
        const dto = res.destroyed ? null : toLiveEventDto(event, userId);
        if (dto) {
          res.write(`event: ${dto.type}\ndata: ${JSON.stringify(dto)}\n\n`);
        }
      });
    } catch (error) {
      await slot.release();
      throw error;
    }
    if (res.destroyed) {
      // The browser left while the subscription started.
      await Promise.all([unsubscribe(), slot.release()]);
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
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
      void slot.renew();
    }, HEARTBEAT_MS);
    const lifetime = setTimeout(() => {
      res.end();
    }, STREAM_LIFETIME_MS);
    res.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      void unsubscribe();
      void slot.release();
    });
  }
}
