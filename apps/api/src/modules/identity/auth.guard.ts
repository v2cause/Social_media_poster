import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { addToLogContext } from '@smp/observability';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';

import { TenantContextService } from '../../common/cls/tenant-context';
import { IS_PUBLIC } from '../../common/decorators/public.decorator';
import { AUTH, type Auth, type AuthSession } from './auth';
import { LocalSession } from './local-session';

export type AuthenticatedRequest = Request & { auth?: AuthSession };

/**
 * First step of the request pipeline (architecture 10): every route needs a valid session
 * unless it is marked @Public(). Puts the user into the request context. In the single-user mode
 * (LOCAL_MODE) the local owner stands in for a missing session.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly reflector: Reflector,
    private readonly tenant: TenantContextService,
    private readonly localSession: LocalSession,
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
    // In the single-user mode a request without a session acts as the local owner (ADR 0046).
    const session =
      (await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) })) ??
      this.localSession.get();
    if (!session) {
      throw new UnauthorizedException();
    }
    request.auth = session;
    this.tenant.set({ userId: session.user.id });
    addToLogContext({ userId: session.user.id });
    return true;
  }
}
