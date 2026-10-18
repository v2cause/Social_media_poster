import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { NotPermittedError, TwoFactorRequiredError } from '@smp/core';

import type { AuthenticatedRequest } from './auth.guard';

/**
 * The routes of the platform admins (guide step 6.1): the flag isPlatformAdmin of the user,
 * which only platform operators set, and a second factor (guide step 8.4), because the switches
 * act on every organization. Runs after the AuthGuard on routes with @UserScope().
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.auth?.user as
      { isPlatformAdmin?: boolean | null; twoFactorEnabled?: boolean | null } | undefined;
    if (user?.isPlatformAdmin !== true) {
      throw new NotPermittedError();
    }
    if (user.twoFactorEnabled !== true) {
      throw new TwoFactorRequiredError();
    }
    return true;
  }
}
