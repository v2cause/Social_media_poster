import { Injectable, type OnApplicationBootstrap, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { Permission } from '@smp/contracts';

import {
  REQUIRED_PERMISSION,
  TENANT_SCOPE,
  USER_SCOPE,
  type TenantScopeKind,
} from '../decorators/access.decorators';
import { IS_PUBLIC } from '../decorators/public.decorator';

export interface RouteAccess {
  method: string;
  path: string;
  access: 'public' | 'user' | 'permission' | 'none';
  permission?: Permission;
  scope?: TenantScopeKind;
  problem?: string;
}

const joinPath = (...parts: string[]): string =>
  `/${parts
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .join('/')}`;

/**
 * Deny by default (guide step 1.6): lists every route at startup and stops the application if a
 * route has no access rule, more than one, or a permission without tenant scope.
 */
@Injectable()
export class RouteAccessCheck implements OnApplicationBootstrap {
  routes: RouteAccess[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    this.routes = this.collect();
    const problems = this.routes.filter((route) => route.problem);
    if (problems.length > 0) {
      const lines = problems.map((route) => `  ${route.method} ${route.path}: ${route.problem ?? ''}`);
      throw new Error(`Routes without a valid access rule:\n${lines.join('\n')}`);
    }
  }

  private collect(): RouteAccess[] {
    const routes: RouteAccess[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      const controller = wrapper.metatype;
      if (!instance || !controller) {
        continue;
      }
      const prototype = Object.getPrototypeOf(instance) as object;
      const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') {
          continue;
        }
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (path === undefined) {
          continue;
        }
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
        const targets = [handler, controller];
        const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) === true;
        const isUser = this.reflector.getAllAndOverride<boolean | undefined>(USER_SCOPE, targets) === true;
        const permission = this.reflector.get<Permission | undefined>(REQUIRED_PERMISSION, handler);
        const scope = this.reflector.getAllAndOverride<TenantScopeKind | undefined>(TENANT_SCOPE, targets);

        const rules = [isPublic, isUser, permission !== undefined].filter(Boolean).length;
        const access = isPublic ? 'public' : isUser ? 'user' : permission ? 'permission' : 'none';
        let problem: string | undefined;
        if (rules === 0) {
          problem = 'needs @Public(), @UserScope() or @RequirePermission()';
        } else if (rules > 1) {
          problem = 'has more than one of @Public(), @UserScope() and @RequirePermission()';
        } else if (permission && !scope) {
          problem = '@RequirePermission() needs @OrgScope() or @WorkspaceScope() on the controller';
        } else if (scope && !permission) {
          problem = 'a tenant route needs @RequirePermission()';
        }
        routes.push({ method, path: joinPath('api', base, path), access, permission, scope, problem });
      }
    }
    return routes;
  }
}
