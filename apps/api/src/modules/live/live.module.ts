import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { LiveEventHub } from './live-event-hub';
import { LiveEventsController } from './live-events.controller';

/** The live events of a workspace over server-sent events (guide step 4.10). */
@Module({ imports: [AccessModule], controllers: [LiveEventsController], providers: [LiveEventHub] })
export class LiveModule {}
