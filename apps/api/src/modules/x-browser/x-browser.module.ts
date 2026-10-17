import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { XBrowserAdminController } from './x-browser-admin.controller';
import { XBrowserLoginController } from './x-browser-login.controller';
import { XBrowserController } from './x-browser.controller';
import { xBrowserProviders } from './x-browser.providers';

/**
 * The optional X browser (phase 6): switching per workspace, the interactive login and the
 * switches of the platform admins.
 */
@Module({
  imports: [IdentityModule],
  controllers: [XBrowserController, XBrowserLoginController, XBrowserAdminController],
  providers: xBrowserProviders,
})
export class XBrowserModule {}
