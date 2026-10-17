import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { XBrowserAdminController } from './x-browser-admin.controller';
import { XBrowserController } from './x-browser.controller';
import { xBrowserProviders } from './x-browser.providers';

/** The optional X browser (phase 6): switching per workspace and the switches of the platform admins. */
@Module({
  imports: [IdentityModule],
  controllers: [XBrowserController, XBrowserAdminController],
  providers: xBrowserProviders,
})
export class XBrowserModule {}
