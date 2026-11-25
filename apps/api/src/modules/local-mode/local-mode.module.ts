import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { LocalOwnerBootstrap } from './local-owner.bootstrap';

/** The single-user mode (ADR 0046); does nothing unless LOCAL_MODE is true. */
@Module({
  imports: [IdentityModule, TenancyModule],
  providers: [LocalOwnerBootstrap],
})
export class LocalModeModule {}
