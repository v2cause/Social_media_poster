import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { AiController } from './ai.controller';
import { BrandVoicesController, StylesController } from './brand.controller';
import { contentProviders } from './content.providers';
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
})
export class ContentModule {}
