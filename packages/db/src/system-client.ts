import { AsyncLocalStorage } from 'node:async_hooks';

import { createPrismaClient } from './client';
import { Prisma } from './generated/prisma/client';

// app_system bypasses row-level security. It is reserved for the few cross-tenant scans of the
// architecture (6.3) and may run only inside repository methods marked with @SystemScope().
// Outside such a method every operation of the system client throws.

const systemScope = new AsyncLocalStorage<true>();

export class SystemScopeViolationError extends Error {
  readonly code = 'tenant.system_scope_violation';

  constructor(operation: string) {
    super(`${operation} on the system client is only allowed inside a @SystemScope() method.`);
    this.name = 'SystemScopeViolationError';
  }
}

/**
 * Runs fn with access to the system client. Prefer the @SystemScope() decorator. Awaits inside
 * the scope, because Prisma queries are lazy and would otherwise execute after it has ended.
 */
export const runInSystemScope = <T>(fn: () => PromiseLike<T>): Promise<T> =>
  systemScope.run(true, async () => await fn());

/** Marks a repository method as a cross-tenant scan that may use the system client. */
export function SystemScope(): MethodDecorator {
  return (_target, _key, descriptor) => {
    const original = descriptor.value;
    if (typeof original !== 'function') {
      throw new TypeError('@SystemScope() decorates methods only');
    }
    const wrapped = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      return runInSystemScope(() => original.apply(this, args) as PromiseLike<unknown>);
    };
    (descriptor as PropertyDescriptor).value = wrapped;
    return descriptor;
  };
}

const systemScopeGuard = Prisma.defineExtension({
  name: 'system-scope-guard',
  query: {
    $allOperations({ model, operation, args, query }) {
      if (systemScope.getStore() !== true) {
        throw new SystemScopeViolationError(model ? `${model}.${operation}` : operation);
      }
      return query(args);
    },
  },
});

/** The app_system client. Pass DATABASE_SYSTEM_URL. */
export const createSystemPrismaClient = (connectionString: string) =>
  createPrismaClient(connectionString).$extends(systemScopeGuard);

export type SystemPrismaClient = ReturnType<typeof createSystemPrismaClient>;
