import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { MediaController } from './media.controller';
import { mediaProviders } from './media.providers';

/** The media library: upload tickets, completion, alt text and deletion (guide step 3.3). */
@Module({
  imports: [AccessModule],
  controllers: [MediaController],
  providers: mediaProviders,
})
export class MediaModule {}
