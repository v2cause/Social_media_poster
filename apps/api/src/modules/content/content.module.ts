import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { AiController } from './ai.controller';
import { BrandVoicesController, StylesController } from './brand.controller';
import { AiRateLimiter } from './ai-rate-limiter';
import { AI_DEPENDENCIES, contentProviders } from './content.providers';
import { IdeasController } from './ideas.controller';
import { PostsController, VariantsController } from './posts.controller';

/** Posts, variants, styles, brand voices, ideas and the AI routes (guide step 2.7). */
@Module({
  imports: [AccessModule],
  controllers: [
    PostsController,
    VariantsController,
    StylesController,
    BrandVoicesController,
    IdeasController,
    AiController,
  ],
  providers: contentProviders,
  // The diagrams of the media library are AI calls with the same metering and rate limits.
  exports: [AI_DEPENDENCIES, AiRateLimiter],
})
export class ContentModule {}
