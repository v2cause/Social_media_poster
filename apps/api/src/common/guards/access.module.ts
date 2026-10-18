import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';

import { AuthGuard } from '../../modules/identity/auth.guard';
import { IdentityModule } from '../../modules/identity/identity.module';
import { AccessCache } from './access-cache';
import { DeletedOrganizationGuard } from './deleted-organization.guard';
import { PermissionGuard } from './permission.guard';
import { ReadOnlyGuard } from './read-only.guard';
import { RouteAccessCheck } from './route-access.check';
import { WorkspaceGuard } from './workspace.guard';

/**
 * The request pipeline of the architecture (section 10), in this order: session, tenant, the
 * deletion of the organization (guide step 8.2), permission, then the subscription for changes
 * (guide step 7.4). Global guards run in the order they are registered here.
 */
@Module({
  imports: [DiscoveryModule, IdentityModule],
  providers: [
    AccessCache,
    RouteAccessCheck,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: WorkspaceGuard },
    { provide: APP_GUARD, useClass: DeletedOrganizationGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: ReadOnlyGuard },
  ],
  exports: [AccessCache, RouteAccessCheck],
})
export class AccessModule {}
