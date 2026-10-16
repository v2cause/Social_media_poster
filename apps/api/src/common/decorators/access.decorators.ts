import { applyDecorators, SetMetadata } from '@nestjs/common';
import type { Permission } from '@smp/contracts';

// Route access metadata (guide step 1.6). Every route carries exactly one of @Public(),
// @UserScope() or @RequirePermission(); the startup check enforces it.

export const USER_SCOPE = 'smp:user-scope';
export const TENANT_SCOPE = 'smp:tenant-scope';
export const REQUIRED_PERMISSION = 'smp:required-permission';

export type TenantScopeKind = 'organization' | 'workspace';

/** A session is enough; the route is not bound to an organization or workspace. */
export const UserScope = (): MethodDecorator & ClassDecorator => SetMetadata(USER_SCOPE, true);

/** Routes under /org/:org. The guard resolves the membership and sets the organization context. */
export const OrgScope = (): ClassDecorator =>
  SetMetadata(TENANT_SCOPE, 'organization' satisfies TenantScopeKind);

/** Routes under /w/:ws. The guard resolves the workspace by slug and sets the tenant context. */
export const WorkspaceScope = (): ClassDecorator =>
  SetMetadata(TENANT_SCOPE, 'workspace' satisfies TenantScopeKind);

/** The permission the caller's role must grant (permission matrix in @smp/contracts). */
export const RequirePermission = (permission: Permission): MethodDecorator =>
  applyDecorators(SetMetadata(REQUIRED_PERMISSION, permission));
