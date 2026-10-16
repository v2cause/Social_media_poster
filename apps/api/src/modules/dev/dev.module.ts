import { Module } from '@nestjs/common';

import { MockOAuthController } from './mock-oauth.controller';

/** Tools of development and tests; AppModule leaves this module out in production. */
@Module({
  controllers: [MockOAuthController],
})
export class DevModule {}
