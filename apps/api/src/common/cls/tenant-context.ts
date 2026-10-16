import { Injectable } from '@nestjs/common';
import { MissingTenantContextError, type TenantContext } from '@smp/db';
import { ClsService, type ClsStore } from 'nestjs-cls';

/** Request-scoped values, kept in AsyncLocalStorage by nestjs-cls (architecture 6.3 and 10). */
export interface RequestContextStore extends ClsStore {
  /** Set by the guards: the signed-in user and, on tenant routes, organization and workspace. */
  tenant?: TenantContext;
}

/** Reads and writes the tenant of the current request. The tenant Prisma client reads it here. */
@Injectable()
export class TenantContextService {
  constructor(private readonly cls: ClsService<RequestContextStore>) {}

  /** The tenant of the current request, or undefined outside a request or before the guards. */
  get(): TenantContext | undefined {
    return this.cls.isActive() ? this.cls.get('tenant') : undefined;
  }

  require(): TenantContext {
    const context = this.get();
    if (!context) {
      throw new MissingTenantContextError('this request');
    }
    return context;
  }

  set(context: TenantContext): void {
    this.cls.set('tenant', context);
  }
}
