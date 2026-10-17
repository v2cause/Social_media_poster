import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { DataExportsController } from './data-exports.controller';
import { gdprProviders } from './gdpr.providers';

/** Data protection of an organization: its exports (guide step 8.1). */
@Module({
  imports: [AccessModule],
  controllers: [DataExportsController],
  providers: gdprProviders,
})
export class GdprModule {}
