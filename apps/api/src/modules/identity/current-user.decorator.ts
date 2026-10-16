import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';

import type { AuthSession } from './auth';
import type { AuthenticatedRequest } from './auth.guard';

/** The signed-in user of the request, set by the AuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthSession['user'] => {
    const session = context.switchToHttp().getRequest<AuthenticatedRequest>().auth;
    if (!session) {
      throw new UnauthorizedException();
    }
    return session.user;
  },
);
