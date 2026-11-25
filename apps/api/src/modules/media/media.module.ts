import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { ContentModule } from '../content/content.module';
import { MediaController } from './media.controller';
import { mediaProviders } from './media.providers';

/**
 * The media library: upload tickets, completion, alt text and deletion (guide step 3.3), the
 * download as JPEG and the diagrams drawn by the AI (ADR 0048).
 */
@Module({
  imports: [AccessModule, ContentModule],
  controllers: [MediaController],
  providers: mediaProviders,
})
export class MediaModule {}
