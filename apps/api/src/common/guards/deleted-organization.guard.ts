import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationDeletionPendingError } from '@smp/core';

import { ALLOW_WHEN_DELETED } from '../decorators/access.decorators';
import type { RequestWithAccess } from './request-access';

/**
 * Third step of the request pipeline (guide step 8.2, ADR 0037): an organization an owner deleted
 * waits for its erasure, and nobody works in it any more. Its routes answer 409
 * ORGANIZATION_DELETION_PENDING, apart from those marked @AllowWhenDeleted(); the permission check
 * still follows for those. Routes without a tenant pass.
 */
@Injectable()
export class DeletedOrganizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithAccess>();
    if (!request.access?.deletedAt) {
      return true;
    }
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_WHEN_DELETED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed) {
      throw new OrganizationDeletionPendingError();
    }
    return true;
  }
}
