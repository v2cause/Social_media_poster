import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementsService } from '@smp/core';

import { ALLOW_WHEN_READ_ONLY } from '../decorators/access.decorators';
import type { RequestWithAccess } from './request-access';

/** Methods that change nothing. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Fourth step of the request pipeline (guide step 7.4): an organization whose trial or grace
 * period ended, or whose subscription ended, is read-only. Its changes answer 402
 * SUBSCRIPTION_INACTIVE, apart from the routes marked @AllowWhenReadOnly(). Routes without a
 * tenant pass.
 */
@Injectable()
export class ReadOnlyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAccess>();
    if (SAFE_METHODS.has(request.method) || !request.access) {
      return true;
    }
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_WHEN_READ_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed) {
      await this.entitlements.assertWritable(request.access.organizationId);
    }
    return true;
  }
}
