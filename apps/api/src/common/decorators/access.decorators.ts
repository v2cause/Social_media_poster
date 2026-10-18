import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import type { Permission } from '@smp/contracts';

// Route access metadata (guide step 1.6). Every route carries exactly one of @Public(),
// @UserScope() or @RequirePermission(); the startup check enforces it.

export const USER_SCOPE = 'smp:user-scope';
export const TENANT_SCOPE = 'smp:tenant-scope';
export const REQUIRED_PERMISSION = 'smp:required-permission';
export const ALLOW_WHEN_READ_ONLY = 'smp:allow-when-read-only';
export const ALLOW_WHEN_DELETED = 'smp:allow-when-deleted';

export type TenantScopeKind = 'organization' | 'workspace';

/** A session is enough; the route is not bound to an organization or workspace. */
export const UserScope = (): MethodDecorator & ClassDecorator => SetMetadata(USER_SCOPE, true);

/** Routes under /org/:org. The guard resolves the membership and sets the organization context. */
export const OrgScope = (): ClassDecorator =>
  applyDecorators(
    SetMetadata(TENANT_SCOPE, 'organization' satisfies TenantScopeKind),
    ApiParam({ name: 'org', description: 'Organization id', schema: { type: 'string', format: 'uuid' } }),
  );

/** Routes under /w/:ws. The guard resolves the workspace by slug and sets the tenant context. */
export const WorkspaceScope = (): ClassDecorator =>
  applyDecorators(
    SetMetadata(TENANT_SCOPE, 'workspace' satisfies TenantScopeKind),
    ApiParam({ name: 'ws', description: 'Workspace slug', schema: { type: 'string' } }),
  );

/** The permission the caller's role must grant (permission matrix in @smp/contracts). */
export const RequirePermission = (permission: Permission): MethodDecorator =>
  applyDecorators(SetMetadata(REQUIRED_PERMISSION, permission));

/**
 * A change an organization may still make while it is read-only (guide step 7.4): the billing
 * that makes it writable again, and what reduces its usage, such as removing a member or
 * deleting media.
 */
export const AllowWhenReadOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_WHEN_READ_ONLY, true);

/**
 * A route an organization keeps while it waits for its erasure (guide step 8.2): the contexts,
 * which show the deletion, the data exports and taking the deletion back.
 */
export const AllowWhenDeleted = (): MethodDecorator & ClassDecorator => SetMetadata(ALLOW_WHEN_DELETED, true);
