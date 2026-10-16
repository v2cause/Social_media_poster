import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { IdentityModule } from '../identity/identity.module';
import { AccountsController } from './accounts.controller';
import { ChannelsController } from './channels.controller';
import { channelProviders } from './channels.providers';
import { OAuthCallbackController } from './oauth-callback.controller';

/** Connecting platforms and their accounts with OAuth (guide step 4.5). */
@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [ChannelsController, AccountsController, OAuthCallbackController],
  providers: channelProviders,
})
export class ChannelsModule {}
