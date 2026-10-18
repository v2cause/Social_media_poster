import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationNotFoundError, SLUG_PATTERN, WorkspaceNotFoundError } from '@smp/core';
import type { TenancyReadModel } from '@smp/db';

import { TENANCY_READ_MODEL } from '../../infrastructure/clients.module';
import type { AuthenticatedRequest } from '../../modules/identity/auth.guard';
import { TenantContextService } from '../cls/tenant-context';
import { TENANT_SCOPE, type TenantScopeKind } from '../decorators/access.decorators';
import { AccessCache, type CachedAccess } from './access-cache';
import type { RequestWithAccess } from './request-access';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Second step of the request pipeline (architecture 10): resolves /w/:ws or /org/:org to the
 * caller's membership and role and sets the tenant context. Foreign or unknown tenants answer 404,
 * never 403, so that nothing reveals whether they exist.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenant: TenantContextService,
    private readonly cache: AccessCache,
    @Inject(TENANCY_READ_MODEL) private readonly readModel: TenancyReadModel,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<TenantScopeKind | undefined>(TENANT_SCOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!scope) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest & RequestWithAccess>();
    const userId = request.auth?.user.id;
    if (!userId) {
      // The AuthGuard runs first; a tenant route without session is a wiring error.
      throw new OrganizationNotFoundError();
    }
    const access =
      scope === 'workspace'
        ? await this.resolveWorkspace(userId, request.params['ws'])
        : await this.resolveOrganization(userId, request.params['org']);

    request.access = { userId, ...access };
    this.tenant.set({ userId, organizationId: access.organizationId, workspaceId: access.workspaceId });
    return true;
  }

  private async resolveWorkspace(userId: string, slug: unknown): Promise<CachedAccess> {
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
      throw new WorkspaceNotFoundError();
    }
    const field = `ws:${slug}`;
    const cached = await this.cache.get(userId, field);
    if (cached) {
      return cached;
    }
    const resolved = await this.readModel.resolveWorkspace(userId, slug);
    if (!resolved) {
      throw new WorkspaceNotFoundError();
    }
    const access = {
      organizationId: resolved.organization.id,
      organizationName: resolved.organization.name,
      role: resolved.role,
      workspaceId: resolved.workspace.id,
      deletedAt: resolved.organization.deletedAt?.toISOString() ?? null,
    };
    await this.cache.set(userId, field, access);
    return access;
  }

  private async resolveOrganization(userId: string, organizationId: unknown): Promise<CachedAccess> {
    if (typeof organizationId !== 'string' || !UUID.test(organizationId)) {
      throw new OrganizationNotFoundError();
    }
    const field = `org:${organizationId}`;
    const cached = await this.cache.get(userId, field);
    if (cached) {
      return cached;
    }
    const resolved = await this.readModel.resolveOrganization(userId, organizationId);
    if (!resolved) {
      throw new OrganizationNotFoundError();
    }
    const access = {
      organizationId: resolved.organization.id,
      organizationName: resolved.organization.name,
      role: resolved.role,
      deletedAt: resolved.organization.deletedAt?.toISOString() ?? null,
    };
    await this.cache.set(userId, field, access);
    return access;
  }
}
