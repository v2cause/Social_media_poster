import { Module } from '@nestjs/common';
import { CreateOrganization } from '@smp/core';

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
  // The single-user mode creates the organization of the local owner at the start (ADR 0046).
  exports: [CreateOrganization],
})
export class TenancyModule {}
