import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { LiveEventHub } from './live-event-hub';
import { LiveEventsController } from './live-events.controller';
import { DEFAULT_LIVE_STREAM_LIMITS, LIVE_STREAM_LIMITS, LiveStreamSlots } from './live-stream-slots';

/** The live events of a workspace over server-sent events (guide step 4.10). */
@Module({
  imports: [AccessModule],
  controllers: [LiveEventsController],
  providers: [
    LiveEventHub,
    LiveStreamSlots,
    { provide: LIVE_STREAM_LIMITS, useValue: DEFAULT_LIVE_STREAM_LIMITS },
  ],
})
export class LiveModule {}
