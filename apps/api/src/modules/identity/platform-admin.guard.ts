import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { NotPermittedError } from '@smp/core';

import type { AuthenticatedRequest } from './auth.guard';

/**
 * The routes of the platform admins (guide step 6.1): the flag isPlatformAdmin of the user,
 * which only platform operators set. Runs after the AuthGuard on routes with @UserScope().
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.auth?.user.isPlatformAdmin !== true) {
      throw new NotPermittedError();
    }
    return true;
  }
}
