import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { PublishingController } from './publishing.controller';
import { publishingProviders } from './publishing.providers';

/** Planning and publishing variants (guide step 4.6). */
@Module({
  imports: [AccessModule],
  controllers: [PublishingController],
  providers: publishingProviders,
})
export class PublishingModule {}
