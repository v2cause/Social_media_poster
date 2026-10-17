import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { AnalyticsController } from './analytics.controller';
import { analyticsProviders } from './analytics.providers';

/** The analytics of a workspace (guide step 5.4). */
@Module({
  imports: [AccessModule],
  controllers: [AnalyticsController],
  providers: analyticsProviders,
})
export class AnalyticsModule {}
