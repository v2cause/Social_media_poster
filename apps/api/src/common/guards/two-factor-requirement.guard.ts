import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { TwoFactorRequiredError } from '@smp/core';

import type { AuthenticatedRequest } from '../../modules/identity/auth.guard';
import type { RequestWithAccess } from './request-access';

/**
 * After the deletion check in the request pipeline (architecture 10, guide step 8.4): in an
 * organization whose owners require a second factor, a member without one gets 403
 * TWO_FACTOR_REQUIRED on every route of it until one is set up. The routes of the account, such
 * as the setup of the second factor itself, have no tenant and pass.
 */
@Injectable()
export class TwoFactorRequirementGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest & RequestWithAccess>();
    const user = request.auth?.user as { twoFactorEnabled?: boolean | null } | undefined;
    if (request.access?.requireTwoFactor && user?.twoFactorEnabled !== true) {
      throw new TwoFactorRequiredError();
    }
    return true;
  }
}
