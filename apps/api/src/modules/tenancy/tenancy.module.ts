import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { InvitationsController } from './invitations.controller';
import { MembershipsController } from './memberships.controller';
import { OrganizationController } from './organization.controller';
import { tenancyProviders } from './tenancy.providers';
import { WorkspaceController } from './workspace.controller';

@Module({
  imports: [AccessModule],
  controllers: [MembershipsController, OrganizationController, WorkspaceController, InvitationsController],
  providers: tenancyProviders,
})
export class TenancyModule {}
