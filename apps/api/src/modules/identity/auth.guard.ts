import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';

import { TenantContextService } from '../../common/cls/tenant-context';
import { IS_PUBLIC } from '../../common/decorators/public.decorator';
import { AUTH, type Auth, type AuthSession } from './auth';

export type AuthenticatedRequest = Request & { auth?: AuthSession };

/**
 * First step of the request pipeline (architecture 10): every route needs a valid session
 * unless it is marked @Public(). Puts the user into the request context.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly reflector: Reflector,
    private readonly tenant: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) {
      throw new UnauthorizedException();
    }
    request.auth = session;
    this.tenant.set({ userId: session.user.id });
    return true;
  }
}
