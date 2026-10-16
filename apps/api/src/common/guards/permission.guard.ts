import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Permission } from '@smp/contracts';
import { NotPermittedError } from '@smp/core';

import { REQUIRED_PERMISSION } from '../decorators/access.decorators';
import { requireAccess, type RequestWithAccess } from './request-access';

/** Third step of the request pipeline: the caller's role must grant the route's permission. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.get<Permission | undefined>(REQUIRED_PERMISSION, context.getHandler());
    if (!permission) {
      return true;
    }
    const access = requireAccess(context.switchToHttp().getRequest<RequestWithAccess>());
    if (!can(access.role, permission)) {
      throw new NotPermittedError();
    }
    return true;
  }
}
