import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';

import { AuthGuard } from '../../modules/identity/auth.guard';
import { IdentityModule } from '../../modules/identity/identity.module';
import { AccessCache } from './access-cache';
import { PermissionGuard } from './permission.guard';
import { RouteAccessCheck } from './route-access.check';
import { WorkspaceGuard } from './workspace.guard';

/**
 * The request pipeline of the architecture (section 10), in this order: session, tenant,
 * permission. Global guards run in the order they are registered here.
 */
@Module({
  imports: [DiscoveryModule, IdentityModule],
  providers: [
    AccessCache,
    RouteAccessCheck,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: WorkspaceGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AccessCache, RouteAccessCheck],
})
export class AccessModule {}
